'use strict';
var http = require('http');
var lib = require('http-helper-functions');
var db = require('./permissions-db.js');
var querystring = require('querystring');
var url = require('url');
var pge = require('pg-event-consumer');

var PROTOCOL = process.env.PROTOCOL || 'http:';
var ANYONE = 'http://apigee.com/users/anyone';
var INCOGNITO = 'http://apigee.com/users/incognito';

var OPERATIONPROPERTIES = ['grantsCreateAcessTo', 'grantsReadAccessTo', 'grantsUpdateAccessTo', 'grantsDeleteAccessTo', 'grantsAddAccessTo', 'grantsRemoveAccessTo'];
var OPERATIONS = ['create', 'read', 'update', 'delete', 'add', 'remove'];

function getAllowedActions(req, res, queryString) {
  var queryParts = querystring.parse(queryString);
  var resource = lib.internalizeURL(queryParts.resource, req.headers.host);
  var user = queryParts.user;
  var property = queryParts.property || '_resource';
  if (user == lib.getUser(req)) { 
    withAllowedActionsDo(req, res, resource, property, function(allowedActions) {
      lib.found(req, res, allowedActions);
    });
  } else {
    lib.badRequest(res, 'user in query string must match user credentials')
  }
}

function collateAllowedActions(permissionsObject, property, actors) {
  permissionsObject = permissionsObject[property];
  if (permissionsObject !== undefined) {
    var allowedActions = {};
    for (var i = 0; i < OPERATIONPROPERTIES.length; i++) {
      var actionProperty = OPERATIONPROPERTIES[i];
      var allowedActors = permissionsObject[actionProperty];
      if (allowedActors !== undefined) {
        if (allowedActors.indexOf(INCOGNITO) > -1) { 
          allowedActions[OPERATIONS[i]] = true;
        } else if (actors !== null) {
          if (allowedActors.indexOf(ANYONE) > -1) {
            allowedActions[OPERATIONS[i]] = true;          
          } else {
            for (var j=0; j<actors.length; j++) {
              var user = actors[j];
              if (allowedActors.indexOf(user) > -1 ) { 
                allowedActions[OPERATIONS[i]] = true;
              }
            }
          }
        }
      }
    }
  }
  return allowedActions;
}

function isActionAllowed(permissionsObject, property, actors, action) {
  permissionsObject = permissionsObject[property];
  if (permissionsObject !== undefined) {
    var actionProperty = OPERATIONPROPERTIES[OPERATIONS.indexOf(action)];
    var allowedActors = permissionsObject[actionProperty];
    if (allowedActors !== undefined) {
      if (allowedActors.indexOf(INCOGNITO) > -1) { 
        return true;
      } else if (actors !== null) {
        if (allowedActors.indexOf(ANYONE) > -1) {
          return true;
        } else {
          for (var j=0; j<actors.length; j++) {
            var actor = actors[j];
            if (allowedActors.indexOf(actor) > -1 ) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

function cache(resource, permissions, etag) {
  permissions._Etag = etag;
  permissionsCache[resource] = permissions;
}

function withPermissionsDo(req, res, resource, callback) {
  var permissions = permissionsCache[resource];
  if (permissions !== undefined) {
    callback(permissions, permissions._Etag);
  } else {
    db.withPermissionsDo(req, res, resource, function(permissions, etag) {
      cache(resource, permissions, etag);
      callback(permissions, etag);
    });
  }
}

function withAncestorPermissionsDo(req, res, subject, itemCallback, finalCallback) {
  var recursionSet = {};
  function ancestors(resource) {
    withPermissionsDo(req, res, resource, function(permissions) {
      var stopHere = itemCallback(permissions);
      if (stopHere) {
        finalCallback(stopHere);
      } else {
        var inheritsPermissionsOf = permissions._permissions.inheritsPermissionsOf;
        if (inheritsPermissionsOf !== undefined) {
          inheritsPermissionsOf = inheritsPermissionsOf.filter(x => !(x in recursionSet)); 
          if (inheritsPermissionsOf.length > 0) {
            var count = 0;
            for (var j = 0; j < inheritsPermissionsOf.length; j++) {
              recursionSet[inheritsPermissionsOf[j]] = true; 
              ancestors(inheritsPermissionsOf[j], function() {
                if (++count == inheritsPermissionsOf.length) {
                  finalCallback();
                }
              });
            }
          } else {
            finalCallback();
          }
        } else {
          finalCallback();
        }
      }
    });
  }
  ancestors(subject);
}

function withPermissionFlagDo(req, res, subject, property, action, callback) {
  var user = lib.getUser(req);
  var actors = teamsCache[user]; 
  if (actors !== undefined) {
    withActorsDo(actors);
  } else {
    lib.withTeamsDo(req, res, user, function(actors) {
      teamsCache[user] = actors;
      withActorsDo(actors);
    });
  }
  function withActorsDo (actors) {  
    withAncestorPermissionsDo(req, res, subject, function(permissions) {
      return isActionAllowed(permissions, property, actors, action);
    }, function(allowed) {callback(!!allowed)}); 
  }
}

function withAllowedActionsDo(req, res, resource, property, callback) {
  var user = lib.getUser(req);
  var actors = teamsCache[user]; 
  if (actors !== undefined) {
    withActorsDo(actors);
  } else {
    lib.withTeamsDo(req, res, user, function(actors) {
      teamsCache[user] = actors;
      withActorsDo(actors);
    });
  }
  function withActorsDo (actors) {  
    var actions = {};
    withAncestorPermissionsDo(req, res, resource, function(permissions) {
      Object.assign(actions, collateAllowedActions(permissions, property, actors));
      return false;
    }, function() {callback(Object.keys(actions))}); 
  }
}

function isAllowed(req, res, queryString) {
  var queryParts = querystring.parse(queryString);
  var user = queryParts.user;
  var action = queryParts.action;
  var property = queryParts.property;
  if (action !== undefined && queryParts.resource !== undefined && user == lib.getUser(req)) {
    var resources = Array.isArray(queryParts.resource) ? queryParts.resource : [queryParts.resource];
    resources = resources.map(x => lib.internalizeURL(x));
    var count = 0;
    var result = true;
    var responded = false;
    for (var i = 0; i< resources.length; i++) {
      var resource = resources[i];
      var resourceParts = url.parse(resource);
      withPermissionFlagDo(req, res, resource, property, action, function(answer) {
        if (!responded) {
          if (++count == resources.length) {
            lib.found(req, res, answer && result);
          } else if (answer == false) {
            lib.found(req, res, false);
            responded = true;
          }
        }
      });
    }
  } else {
    lib.badRequest(res, 'action and resource must be provided and user in query string must match user credentials ' + req.url)
  }
}

function isAllowedToInheritFrom(req, res, queryString) {
  function withExistingAncestorsDo(resource, callback) {
    var ancestors = [];
    withAncestorPermissionsDo(req, res, resource, function(permissions) {ancestors.push(permissions._resource._self);}, function(){
      callback(Array.from(new Set(ancestors)));
    });
  }
  function withPotentialAncestorsDo(ancestors, callback) {
    var allAncestors = ancestors.slice();
    var count = 0;
    for (var i = 0; i < ancestors.length; i++) {
      withAncestorPermissionsDo(req, res, ancestors[i], function(permissions) {allAncestors.push(permissions._resource._self);}, function(){
        if (++count == ancestors.length) {
          callback(Array.from(new Set(allAncestors)));
        }
      });      
    }
  }
  var queryParts = querystring.parse(queryString);
  var subject = queryParts.subject;
  if (subject !== undefined) {
    subject = lib.internalizeURL(subject, req.headers.host);
    withPermissionFlagDo(req, res, subject, '_permissions', 'read', function(answer) {
      if (answer) {
        var sharingSet = queryParts.sharingSet;
        var existingAncestors = null;
        var potentialAncestors = sharingSet !== undefined ? null : [];
        withExistingAncestorsDo(subject, function(existing) {
          existingAncestors = existing;
          if (potentialAncestors !== null) {
            processAncestors();
          }
        });
        if (sharingSet !== undefined) {
          var sharingSets = Array.isArray(sharingSet) ? sharingSet : [sharingSet];
          sharingSets = sharingSets.map(anURL => lib.internalizeURL(anURL));
          withPotentialAncestorsDo(sharingSets, function (potential) {
            potentialAncestors = potential;
            if (existingAncestors !== null) {
              processAncestors();
            }
          });
        }
        function processAncestors() {
          if (potentialAncestors.indexOf(subject) == -1) {
            var addedAncestors = potentialAncestors.filter(x=>existingAncestors.indexOf(x) == -1);
            var removedAncestors = existingAncestors.filter(x=>potentialAncestors.indexOf(x) == -1);
            var responded = false;
            var addOK = addedAncestors.length == 0;
            var removeOK = removedAncestors.length == 0;
            if (removedAncestors.length > 0) {
              let count = 0;
              for (let i=0; i < removedAncestors.length; i++) {
                withPermissionFlagDo(req, res, removedAncestors[i], '_permissionsHeirs', 'remove', function(answer) {
                  if (!responded) {
                    if (!answer) {
                      responded = true;
                      lib.found(req, res, {result: false, reason: `may not remove permissions inheritance from ${removedAncestors[i]}`}) 
                    } else {
                      if (++count == removedAncestors.length) {
                        removeOK = true;
                        if (addOK) {
                          lib.found(req, res, {result:true});
                        }
                      }
                    }
                  }
                });
              }
            }
            if (addedAncestors.length > 0) {
              let count = 0;
              for (let i=0; i < addedAncestors.length; i++) {
                withPermissionFlagDo(req, res, addedAncestors[i], '_permissionsHeirs', 'add', function(answer) {
                  if (!responded) {
                    if (!answer) {
                      responded = true;
                      lib.found(req, res, {result: false, reason: `may not add permissions inheritance from ${addedAncestors[i]}`}) 
                    } else {
                      if (++count == addedAncestors.length) {
                        addOK = true;
                        if (removeOK) {
                          lib.found(req, res, {result:true});
                        }
                      }
                    }
                  }
                });
              }
            }
          } else {
            lib.found(req, res, {result: false, reason: `may not add cycle to permisions inheritance`}); // cycles not allowed
          }
        }        
      } else{
        lib.forbidden(req, res)
      }
    });
  } else {
    lib.badRequest(res, `must provide subject in querystring: ${queryString} ${JSON.stringify(queryParts)}`);
  }
}

function processEvent(event) {
  if (event.topic == 'permissions') {
    if (event.data.action == 'deleteAll') {
      console.log(`permissions: processEvent: event.index: ${event.index} event.topic: ${event.topic} event.data.action: deleteAll`);
      permissionsCache = {}
    } else {
      console.log(`permissions: processEvent: event.index: ${event.index} event.topic: ${event.topic} event.data.action: ${event.data.action} subject: ${event.data.subject}`);
      delete permissionsCache[lib.internalizeURL(event.data.subject)];
    }
  } else if (event.topic == 'teams') {
    if (event.data.action == 'update') {
      console.log(`permissions: processEvent: event.index: ${event.index} event.topic: ${event.topic} event.data.action: ${event.data.action} before: ${event.data.before} after ${event.data.after}`);
      var beforeMembers = event.data.before.members || [];
      var afterMembers = event.data.after.members || [];
      var removedMembers = beforeMembers.filter(member => afterMembers.indexOf(member) = -1);
      var addedMembers = afterMembers.filter(member => beforeMembers.indexOf(member) = -1);
      var affectedMembers = removedMembers.concat(addedMembers);
      for (var i = 0; i < affectedMembers.length; i++) {
        delete teamsCache[affectedMembers[i]]
      }
    } else if (event.data.action == 'delete' || event.data.action == 'create') {
      var members = event.data.team.members;
      console.log(`permissions: processEvent: event.index: ${event.index} event.topic: ${event.topic} event.data.action: ${event.data.action} members: `, members);
      if (members !== undefined) {
        for (var i = 0; i < members.length; i++) {
          delete teamsCache[members[i]]
        }
      }
    } else
      console.log(`permissions: processEvent: event.index: ${event.index} event.topic: ${event.topic} event.data.action: ${event.data.action}`);
  } else {
    console.log(`permissions: processEvent: event.index: ${event.index} event.topic: ${event.topic} event.data.action: ${event.data.action}`);    
  }
}

function processEventPost(req, res, event) {
  permissionsEventConsumer.processEvent(event);
  lib.found(req, res);
}

var IPADDRESS = process.env.PORT !== undefined ? `${process.env.IPADDRESS}:${process.env.PORT}` : process.env.IPADDRESS;
var permissionsEventConsumer = new pge.eventConsumer(db.pool, IPADDRESS, processEvent);

var permissionsCache = {};
var teamsCache = {};

function requestHandler(req, res) {
  if (req.url == '/events') {
    if (req.method == 'POST') {
      lib.getServerPostBody(req, res, processEventPost);
    } else { 
      lib.methodNotAllowed(req, res, ['POST']);
    }
  } else {
    var req_url = url.parse(req.url);
    if (req_url.pathname == '/allowed-actions' && req_url.search !== null){ 
      if (req.method == 'GET') {
        getAllowedActions(req, res, lib.internalizeURL(req_url.search.substring(1), req.headers.host));
      } else {
        lib.methodNotAllowed(req, res, ['GET']);
      }
    } else if (req_url.pathname == '/is-allowed' && req_url.search !== null) {
      if (req.method == 'GET') {
        isAllowed(req, res, req_url.search.substring(1));
      } else {
        lib.methodNotAllowed(req, res, ['GET']);
      }
    } else if (req_url.pathname == '/is-allowed-to-inherit-from' && req_url.search !== null) {
      if (req.method == 'GET') {
        isAllowedToInheritFrom(req, res, req_url.search.substring(1));
      } else {
        lib.methodNotAllowed(req, res, ['GET']);
      }
    } else {
      lib.notFound(req, res);
    }
  }
}

db.init(function () {
  var port = process.env.PORT;
  permissionsEventConsumer.init(function() {
    http.createServer(requestHandler).listen(port, function() {
      console.log(`server is listening on ${port}`);
    });
  });
});
