'use strict';
var Pool = require('pg').Pool;
var lib = require('./standard-functions.js');

var ANYONE = 'http://apigee.com/users/anyone';
var INCOGNITO = 'http://apigee.com/users/incognito';

var config = {
  host: process.env.PG_HOST || 'localhost',
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE
};

var pool = new Pool(config);

function withPermissionsDo(req, res, subject, callback) {
  // fetch the permissions resource for `subject`.
  subject = lib.internalizeURL(subject, req.headers.host)
  var query = 'SELECT etag, data FROM permissions WHERE subject = $1'
  pool.query(query,[subject], function (err, pgResult) {
    if (err) {
      lib.internalError(res, err);
    } else {
      if (pgResult.rowCount === 0) { 
        lib.notFound(req, res);
      }
      else {
        var row = pgResult.rows[0];
        callback(row.data, row.etag);
      }
    }
  });
}

function deletePermissionsThen(req, res, subject, callback) {
  // fetch the permissions resource for `subject`.
  subject = lib.internalizeURL(subject, req.headers.host)
  var query = 'DELETE FROM permissions WHERE subject = $1 RETURNING *'
  pool.query(query,[subject], function (err, pgResult) {
    if (err) {
      lib.badRequest(res, err);
    } else {
      if (pgResult.rowCount === 0) { 
        lib.notFound(req, res);
      }
      else {
        var row = pgResult.rows[0];
        callback(row.data, row.etag);
      }
    }
  });
}

function createPermissionsThen(req, res, permissions, callback) {
  // fetch the permissions resource for `subject`.
  lib.internalizeURLs(permissions, req.headers.host);
  pool.query('INSERT INTO permissions (subject, data) values($1, $2) RETURNING etag', [permissions.governs._self, permissions], function (err, pgResult) {
    if (err) {
      if (err.code == 23505){ 
        lib.duplicate(res, err);
      } else { 
        lib.badRequest(res, err);
      }
    } else {
      if (pgResult.rowCount === 0) { 
        lib.internalError(res, 'failed create');
      } else {
        callback(permissions, pgResult.rows[0].etag);
      }
    }
  });
}

function updatePermissionsThen(req, res, subject, patchedPermissions, etag, callback) {
  // We use a transaction here, since its PG and we can. In fact it would be OK to create the invalidation record first and then do the update.
  // If the update failed we would have created an unnecessary invalidation record, which is not ideal, but probably harmless.
  // The converse—creating an update without an invalidation record—could be harmful.
  pool.connect(function(err, client, release) {
    if (err) { 
      lib.badRequest(res, err);
    } else {
      client.query('BEGIN', function(err) {
        if(err) {
          client.query('ROLLBACK', release);
          lib.internalError(res, err);
        } else {
          lib.internalizeURLs(patchedPermissions, req.headers.host);
          var key = lib.internalizeURL(subject, req.headers.host);
          var query = 'UPDATE permissions SET data = ($1) WHERE subject = $2 AND etag = $3 RETURNING etag';
          client.query(query, [patchedPermissions, key, etag], function(err, pgResult) {
            if(err) {
              client.query('ROLLBACK', release);
              lib.internalError(res, err);
            } else {
              if (pgResult.rowCount === 0) {
                client.query('ROLLBACK', release);
                var resErr = 'If-Match header does not match stored etag ' + etag;
                lib.badRequest(res, resErr);
              } else {
                var time = Date.now();
                var query = 'INSERT INTO invalidations (subject, type, etag, invalidationtime) values ($1, $2, $3, $4)'
                client.query(query, [subject, 'permissions', etag, time], function(err) {
                  if(err) {
                    client.query('ROLLBACK', release);
                    lib.internalError(res, err);
                  } else {
                    client.query('COMMIT', release);
                    callback(patchedPermissions, pgResult.rows[0].etag)
                  }
                });
              }
            }
          });
        }
      });
    }
  });  
}

function withResourcesSharedWithActorsDo(req, res, actors, callback) {
  actors = actors == null ? [INCOGNITO] : actors.concat([INCOGNITO, ANYONE]);
  var query = `SELECT subject FROM permissions, jsonb_array_elements(permissions.data->'_sharedWith') 
               AS sharedWith WHERE sharedWith <@ '${JSON.stringify(actors)}'`;
  pool.query(query, function (err, pgResult) {
    if (err) {
      lib.badRequest(res, err);
    } else {
      callback(pgResult.rows.map((row) => {return row.subject;}))
    }
  });
}

function withHeirsDo(req, res, securedObject, callback) {
  var query = `SELECT subject, data FROM permissions WHERE data @> '{"governs": {"inheritsPermissionsOf":["${securedObject}"]}}'`
  pool.query(query, function (err, pgResult) {
    if (err) {
      lib.badRequest(res, err);
    }
    else {
      callback(pgResult.rows.map((row) => {return row.data.governs;}))
    }
  });
}

var TENMINUTES  = 10*60*1000;
var ONEHOUR = 60*60*1000;

function registerCache(ipaddress, callback) {
  var time = Date.now();
  pool.query(`DELETE FROM caches WHERE registrationtime < ${time-TENMINUTES}`, function (err, pgResult) {
    if (err) {
      console.log(`unable to delete old cache registrations ${err}`);
    } else {
      var query = 'INSERT INTO caches (ipaddress, registrationtime) values ($1, $2) ON CONFLICT (ipaddress) DO UPDATE SET registrationtime = EXCLUDED.registrationtime'
      pool.query(query, [ipaddress, time], function (err, pgResult) {
        if (err) {
          console.log(`unable to register ipaddress ${ipaddress} ${err}`);
        }
      });
      var query = 'SELECT ipaddress FROM caches'
      pool.query(query, function (err, pgResult) {
        if (err) {
          console.log(`unable to retrieve ipaddresses from caches ${ipaddress} ${err}`);
        } else {
          callback(pgResult.rows.map((row) => {return row.ipaddress;}));
        }
      });
    }
  });
}

function withInvalidationsAfter(invalidationID, callback) {
  var query = `SELECT subject, type, etag FROM invalidations WHERE invalidationID > ${invalidationID}`;
  pool.query(query, [invalidationID], function(err, pgResult) {
    if (err) {
      console.log(`unable to retrieve validations subsequent to ${invalidationID} ${err}`);      
    } else{
      for (var i=0; i< pgResult.rowCount; i++) {
        callback(pgResult.rows[i]);
      }
    }
  });
}

function discardInvalidationsOlderThan(interval) {
  var time = Date.now() - interval;
  console.log('discardInvalidationsOlderThan:', 'time:', time);
  pool.query(`DELETE FROM invalidations WHERE invalidationtime < ${time}`, function (err, pgResult) {
    if (err) {
      console.log(`unable to delete old invalidations ${err}`);
    } else {
      console.log(`trimmed invalidations older than ${time}`)
    }
  });
}

function logInvalidation(subject, type, etag) {
  var time = Date.now();
  var query = 'INSERT INTO invalidations (subject, type, etag, invalidationtime) values ($1, $2, $3, $4)'
  pool.query(query, [subject, type, etag, time], function (err, pgResult) {
    if (err) {
      console.log(`unable to register ipaddress ${ipaddress}`);
    }
  });
}

function createTablesThen(callback) {
  var query = 'CREATE TABLE IF NOT EXISTS permissions (subject text primary key, etag serial, data jsonb);'
  pool.query(query, function(err, pgResult) {
    if(err) {
      console.error('error creating permissions table', err);
    } else {
      query = 'CREATE TABLE IF NOT EXISTS invalidations (id bigserial, subject text, type text, etag int, invalidationtime bigint);'
      pool.query(query, function(err, pgResult) {
        if(err) {
          console.error('error creating invalidations table', err);
        } else {
          query = 'CREATE TABLE IF NOT EXISTS caches (ipaddress text primary key, registrationtime bigint);'
          pool.query(query, function(err, pgResult) {
            if(err) {
              console.error('error creating caches table', err);
            } else {
              callback()
            }
          });
        }
      });
    }
  });    
}

exports.withPermissionsDo = withPermissionsDo;
exports.createPermissionsThen = createPermissionsThen;
exports.deletePermissionsThen = deletePermissionsThen;
exports.updatePermissionsThen = updatePermissionsThen;
exports.withResourcesSharedWithActorsDo = withResourcesSharedWithActorsDo;
exports.withHeirsDo = withHeirsDo;
exports.createTablesThen = createTablesThen;
exports.registerCache = registerCache;
exports.logInvalidation = logInvalidation;
exports.withInvalidationsAfter = withInvalidationsAfter;
exports.discardInvalidationsOlderThan = discardInvalidationsOlderThan;