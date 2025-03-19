const express = require('express');
const pg = require('pg');
const Connector = require('@google-cloud/cloud-sql-connector').Connector;

const { Pool } = pg;

(async () => {
  let connector;
  let clientOpts;
  let pool;

  console.log(`process.env.CLOUD_SQL_SOCKET = '${process.env.CLOUD_SQL_SOCKET}'`);
  console.log(`process.env.DB_NAME = '${process.env.DB_NAME}'`);
  console.log(`process.env.DB_USER = '${process.env.DB_USER}'`);
  console.log(`process.env.DB_PASSWORD = '${process.env.DB_PASSWORD}'`);

  try {
    connector = new Connector();
    clientOpts = await connector.getOptions({
      instanceConnectionName: process.env.CLOUD_SQL_SOCKET, // 'PROJECT:REGION:INSTANCE'
      authType: 'PASSWORD',
      ipType: 'PRIVATE',
    });
    pool = new Pool({
      ...clientOpts,
      type: 'postgres',
      database: process.env.DB_NAME,      // 'postgres'
      user: process.env.DB_USER,          // 'postgres'
      password: process.env.DB_PASSWORD,  // 'password'

      idleTimeoutMillis:   600000, // 10 minutes
      createTimeoutMillis:   5000, //  5 seconds
      acquireTimeoutMillis:  5000, //  5 seconds
    });
  } catch (e) {
    console.error(e);
  }

  const app = express();
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

  app.listen(port, '0.0.0.0', () => {
    console.log('app is listening on port 3000; allows requests from 0.0.0.0;');
  });

})();
