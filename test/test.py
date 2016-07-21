import requests
import psycopg2
import base64
import json

try:
    conn = psycopg2.connect("dbname='permissions' user='martinnally' host='localhost' password='martinnally'")
except:
    print 'I am unable to connect to the database'

with conn:
    with conn.cursor() as cur:
        cur.execute(""" DROP TABLE IF EXISTS permissions """)
        cur.execute(""" DROP TABLE IF EXISTS teams """)
        cur.execute('CREATE TABLE IF NOT EXISTS permissions (subject text primary key, etag serial, data jsonb)')
        cur.execute('CREATE TABLE IF NOT EXISTS teams (id serial primary key, etag serial, data jsonb)')

def b64_decode(data):
    missing_padding = 4 - len(data) % 4
    if missing_padding:
        data += b'='* missing_padding
    return base64.decodestring(data)

with open('token.txt') as f:
    TOKEN = f.read()
    USER = json.loads(b64_decode(TOKEN.split('.')[1]))['user_id']

permissions = {
 'isA': 'Permissions',
 'governs': 
    {'_self': 'http://google.com/',
     'updaters': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737', 'http://barak-obama.name'],
     'readers': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737', 'http://barak-obama.name'],
     'deleters': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737'],
     'creators': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737']
    },
 'readers': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737', 'http://barak-obama.name'],
 'deleters': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737'],
 'creators': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737'],
 'updaters': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737']     
}
url = 'http://localhost:8080' + '/permissions' 
headers = {'Accept': 'application/json'}
r = requests.post(url, headers=headers, json=permissions)
if r.status_code == 403:
    print 'correctly rejected permissions creation without user' 
else:
    print 'failed to create permissions %s %s' % (r.status_code, r.text)

headers = {'Accept': 'application/json','Authorization': 'BEARER %s' % TOKEN}
r = requests.post(url, headers=headers, json=permissions)
if r.status_code == 201:
    print 'correctly created permissions' 
else:
    print 'failed to create permissions %s %s' % (r.status_code, r.text)

permissions = {
 'isA': 'Permissions',
 'governs': 
    {'_self': 'http://google.com/maps',
     'updaters': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737', 'http://barak-obama.name'],
     'readers': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737', 'http://barak-obama.name'],
     'deleters': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737'],
     'creators': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737']
    },
 'readers': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737', 'http://barak-obama.name'],
 'deleters': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737'],
 'creators': ['997a22a5-e3ee-42f7-a664-ae6aa1c4f737'],
}

headers = {'Accept': 'application/json', 'Authorization': 'BEARER %s' % TOKEN}
r = requests.post(url, headers=headers, json=permissions)
if r.status_code == 201:
    print 'correctly accepted permission with no updater from logged-in user' 
else:
    print 'incorrectly rejected permission with no updater from logged-in user %s %s' % (r.status_code, r.text)

location = r.headers['Location']
headers = {'Accept': 'application/json'}
r = requests.get(location, headers=headers, json=permissions)
if r.status_code == 403:
    print 'correctly rejected read of permission with no user' 
else:
    print 'incorrectly accepted read of permission with no user %s %s' % (r.status_code, r.text)

headers = {'Accept': 'application/json', 'Authorization': 'BEARER %s' % TOKEN}
r = requests.get(location, headers=headers, json=permissions)
if r.status_code == 200:
    print 'correctly accepted read of permission'
    if USER in r.json()['updaters']:
        print 'correctly inserted %s as updater' % USER
    else:
        print 'failed to add %s as updater' % USER
else:
    print 'incorrectly rejected read of permission %s %s' % (r.status_code, r.text)
