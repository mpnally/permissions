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
  pool.query(query,[subject], function (err, pg_res) {
    if (err) {
      lib.internalError(res, err);
    } else {
      if (pg_res.rowCount === 0) { 
        lib.notFound(req, res);
      }
      else {
        var row = pg_res.rows[0];
        callback(row.data, row.etag);
      }
    }
  });
}

function deletePermissionsThen(req, res, subject, callback) {
  // fetch the permissions resource for `subject`.
  subject = lib.internalizeURL(subject, req.headers.host)
  var query = 'DELETE FROM permissions WHERE subject = $1 RETURNING *'
  pool.query(query,[subject], function (err, pg_res) {
    if (err) {
      lib.badRequest(res, err);
    } else {
      if (pg_res.rowCount === 0) { 
        lib.notFound(req, res);
      }
      else {
        var row = pg_res.rows[0];
        callback(row.data, row.etag);
      }
    }
  });
}

function createPermissionsThen(req, res, permissions, callback) {
  // fetch the permissions resource for `subject`.
  lib.internalizeURLs(permissions, req.headers.host);
  pool.query('INSERT INTO permissions (subject, data) values($1, $2) RETURNING etag', [permissions.governs._self, permissions], function (err, pg_res) {
    if (err) {
      if (err.code == 23505){ 
        lib.duplicate(res, err);
      } else { 
        lib.badRequest(res, err);
      }
    } else {
      if (pg_res.rowCount === 0) { 
        lib.internalError(res, 'failed create');
      } else {
        callback(permissions, pg_res.rows[0].etag);
      }
    }
  });
}

function updatePermissionsThen(req, res, subject, patchedPermissions, etag, callback) {
  var query = 'UPDATE permissions SET data = ($1) WHERE subject = $2 AND etag = $3 RETURNING etag'
  lib.internalizeURLs(patchedPermissions, req.headers.host);
  var key = lib.internalizeURL(subject, req.headers.host)
  pool.query(query, [patchedPermissions, key, etag], function (err, pg_res) {
    if (err) { 
      lib.badRequest(res, err);
    } else {
      if (pg_res.rowCount === 0) {
        err = 'If-Match header does not match stored etag ' + etag;
        lib.badRequest(res, err);
      } else {
        var row = pg_res.rows[0];
        callback(patchedPermissions, pg_res.rows[0].etag)
      }
    }
  });
}

function withResourcesSharedWithActorsDo(req, res, actors, callback) {
  actors = actors == null ? [INCOGNITO] : actors.concat([INCOGNITO, ANYONE]);
  var query = `SELECT subject FROM permissions, jsonb_array_elements(permissions.data->'_sharedWith') 
               AS sharedWith WHERE sharedWith <@ '${JSON.stringify(actors)}'`;
  pool.query(query, function (err, pg_res) {
    if (err) {
      lib.badRequest(res, err);
    } else {
      callback(pg_res.rows.map((row) => {return row.subject;}))
    }
  });
}

function withHeirsDo(req, res, securedObject, callback) {
  var query = `SELECT subject, data FROM permissions WHERE data @> '{"governs": {"inheritsPermissionsOf":["${securedObject}"]}}'`
  pool.query(query, function (err, pg_res) {
    if (err) {
      lib.badRequest(res, err);
    }
    else {
      callback(pg_res.rows.map((row) => {return row.data.governs;}))
    }
  });
}

function createTableThen(callback) {
  pool.query('CREATE TABLE IF NOT EXISTS permissions (subject text primary key, etag serial, data jsonb);', function(err, pg_res) {
    if(err) {
      console.error('error creating permissions table', err);
    } else {
      callback()
    }
  });    
}

exports.withPermissionsDo = withPermissionsDo;
exports.createPermissionsThen = createPermissionsThen;
exports.deletePermissionsThen = deletePermissionsThen;
exports.updatePermissionsThen = updatePermissionsThen;
exports.withResourcesSharedWithActorsDo = withResourcesSharedWithActorsDo;
exports.withHeirsDo = withHeirsDo;
exports.createTableThen = createTableThen;