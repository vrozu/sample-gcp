const express = require('express');
var cors = require('cors')
const pg = require('pg');
const Connector = require('@google-cloud/cloud-sql-connector').Connector;
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const { Pool } = pg;

(async () => {
  let connector;
  let clientOpts;
  let pool;

  try {
    connector = new Connector();
    clientOpts = await connector.getOptions({
      instanceConnectionName: process.env.CLOUD_SQL_SOCKET, // 'PROJECT:REGION:INSTANCE'
      authType: 'IAM',
      ipType: 'PRIVATE',
    });
    pool = new Pool({
      ...clientOpts,
      type: 'postgres',

      database: process.env.DB_NAME,      // 'postgres'
      // this can be any database name found on the instance

      user: process.env.DB_USER,          // 'service account e-mail`
      // NOTE: without the ".gserviceaccount.com" domain suffix!
      // NOTE: don't forget to GRANT necessary privileges for this user!

      idleTimeoutMillis: 600000, // 10 minutes
      createTimeoutMillis: 5000, //  5 seconds
      acquireTimeoutMillis: 5000, //  5 seconds
    });
  } catch (e) {
    console.error(e);
  }

  const app = express();
  app.use(cors())

  const port = 3000;

  app.get('/', (req, res) => {
    res.send('Hello World!');
  });

  app.get('/db-init', async (req, res) => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS visits (
      id SERIAL NOT NULL,
      created_at timestamp NOT NULL,
      PRIMARY KEY (id)
    );`);
    } catch (e) {
      res.send(JSON.stringify(e));
      return;
    }

    res.send('DB initialized OK');
  });

  app.get('/db-test', async (req, res) => {
    let response;

    try {
      await pool.query('INSERT INTO visits(created_at) VALUES(NOW())');
      response = await pool.query('SELECT created_at FROM visits ORDER BY created_at DESC LIMIT 5');
    } catch (e) {
      res.send(JSON.stringify(e));
      return;
    }

    if (response && response.rows) {
      res.send(response.rows);
    } else {
      res.send('no data')
    }
  });

  app.get('/secrets', async (req, res) => {
    let client;

    try {
      client = new SecretManagerServiceClient();
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not initialize SecretManagerServiceClient',
        err,
      }));
    }

    const responsePayload = [];

    try {
      const [secrets] = await client.listSecrets({
        parent: 'projects/test-foresite',
      });

      secrets.forEach(secret => {
        const policy = secret.replication.userManaged
          ? secret.replication.userManaged
          : secret.replication.automatic;

          responsePayload.push({
          name: secret.name,
          policy,
        });
      });
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not parse secrets',
        err,
      }));
    }

    return res.status(200).send(JSON.stringify(responsePayload));
  });

  app.listen(port, '0.0.0.0', () => {
    console.log('app is listening on port 3000; allows requests from 0.0.0.0;');
  });

})();
