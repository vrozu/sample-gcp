const axios = require('axios');
const express = require('express');
var cors = require('cors')
const pg = require('pg');
const Connector = require('@google-cloud/cloud-sql-connector').Connector;
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const {GoogleAuth} = require('google-auth-library');

const { Pool } = pg;

const PROJECT_ID = 'projects/test-foresite';

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
  app.use(express.json());

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
        parent: PROJECT_ID,
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
        msg: 'Could not get list of secrets.',
        err,
      }));
    }

    return res.status(200).send(JSON.stringify(responsePayload));
  });

  app.get('/secret/:id', async (req, res) => {
    const secretId = req.params.id;

    let client;

    try {
      client = new SecretManagerServiceClient();
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not initialize SecretManagerServiceClient',
        err,
      }));
    }

    const responsePayload = {};

    try {
      const [version] = await client.accessSecretVersion({
        name: `${PROJECT_ID}/secrets/${secretId}/versions/latest`,
      });

      const payload = version.payload.data.toString();
      responsePayload.payload = payload;
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not extract secret details.',
        err,
      }));
    }

    return res.status(200).send(JSON.stringify(responsePayload));
  });

  app.delete('/secret/:id', async (req, res) => {
    const secretId = req.params.id;

    let client;

    try {
      client = new SecretManagerServiceClient();
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not initialize SecretManagerServiceClient',
        err,
      }));
    }

    try {
      await client.deleteSecret({
        name: `${PROJECT_ID}/secrets/${secretId}`,
      });
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not delete the secret with given name.',
        err,
      }));
    }

    console.log(`Deleted secret ${secretId}`);
    return res.status(200).send(JSON.stringify({ok: 'ok'}));
  });

  app.post('/new-secret', async (req, res) => {
    const secretId = req.body.secretId;
    const secretValue = (typeof req.body.secretValue === 'string') ? req.body.secretValue : '';

    let client;

    try {
      client = new SecretManagerServiceClient();
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not initialize SecretManagerServiceClient',
        err,
      }));
    }

    if (typeof secretId !== 'string') {
      return res.status(500).send(JSON.stringify({
        msg: 'Provided secret name is not a string.',
        err: null,
      }));
    }

    // only alpha numeric characters and dash allowed
    const regexAllowed =  /^[a-zA-Z0-9-]+$/;
    if (!regexAllowed.test(secretId.trim())) {
      return res.status(500).send(JSON.stringify({
        msg: 'Provided secret name should only contain alpha numeric characters and a dash.',
        err: null,
      }));
    }

    const secretConfig = {
      replication: {
        automatic: {},
      },
    };

    try {
      const [secret] = await client.createSecret({
        parent: PROJECT_ID,
        secretId: secretId.trim(),
        secret: secretConfig,
      });
      console.log(`Created secret ${secret.name}`);
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not create a secret with the given name.',
        err,
      }));
    }

    try {
      const payload = Buffer.from(secretValue, 'utf8');
      const [version] = await client.addSecretVersion({
        parent: `${PROJECT_ID}/secrets/${secretId.trim()}`,
        payload: {
          data: payload,
        },
      });
      console.log(`Added secret version ${version.name}`);
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not add initial revision with secret value.',
        err,
      }));
    }

    return res.status(200).send(JSON.stringify({ok: 'ok'}));
  });

  app.get('/secret-annotations/:id', async (req, res) => {
    const secretId = req.params.id;
    let apiResponse;

    try {
      const auth = new GoogleAuth({
        scopes: 'https://www.googleapis.com/auth/cloud-platform'
      });
      const client = await auth.getClient();
      const projectId = await auth.getProjectId();
      const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretId}`;
      apiResponse = await client.request({
        url,
        method: 'get',
      });
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not invoke Google Cloud API for annotation retrieval.',
        err,
      }));
    }

    return res.status(200).send(JSON.stringify(apiResponse?.data?.annotations));
  });

  app.post('/secret-annotations/:id', async (req, res) => {
    const secretId = req.params.id;
    let apiResponse;

    try {
      const auth = new GoogleAuth({
        scopes: 'https://www.googleapis.com/auth/cloud-platform'
      });
      const client = await auth.getClient();
      const projectId = await auth.getProjectId();
      const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretId}?updateMask=annotations`;
      apiResponse = await client.request({
        url,
        method: 'patch',
        data: { annotations: req.body },
      });
    } catch (err) {
      return res.status(500).send(JSON.stringify({
        msg: 'Could not invoke Google Cloud API for annotation creation..',
        err,
      }));
    }

    return res.status(200).send(JSON.stringify({ok: "ok"}));
  });

  app.get('/forge-token', async (req, res) => {
    let appToken;

    try {
      const authorizationHeader = req.headers.authorization;

      if (authorizationHeader && authorizationHeader.startsWith('Bearer ')) {
        // The token is usually in the 'Authorization' header as a Bearer token
        appToken = authorizationHeader.substring(7); // Remove "Bearer "
      }
    } catch (err_1) {
      console.error(err_1);
    }

    const token = (typeof appToken === 'string' && appToken.length > 0) ? appToken : '';

    try {
      await pool.query(`INSERT INTO tokens(token_value) VALUES('${token}')`);
    } catch (err_2) {
      console.error(err_2);
    }

    return res
      .setHeader('content-type', 'application/json')
      .status(200)
      .send(JSON.stringify({ok: "ok", token}));
  });

  app.post('/forge-comment', async (req, res) => {
    const issueIdOrKey = (typeof req.body.issueIdOrKey === 'string') ? req.body.issueIdOrKey : '';
    const commentContent = (typeof req.body.commentContent === 'string') ? req.body.commentContent : '';

    let response;

    try {
      response = await pool.query('SELECT * FROM tokens ORDER BY created_at DESC LIMIT 1;');
    } catch (err_1) {
      console.error(err_1);
    }

    let token;

    if (response && response.rows) {
      token = response.rows[0].token_value;
    } else {
      token = '';
    }

    let rawResponse;
    const ATLASSIAN_PROJECT = 'rozuvan';

    let error = {};

    try {
      rawResponse = await axios.post(
        `https://${ATLASSIAN_PROJECT}.atlassian.net/rest/api/3/issue/${issueIdOrKey}/comment`,
        {
          params: {
            "body": {
              "type": "doc",
              "version": 1,
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": commentContent,
                    }
                  ]
                }
              ]
            },
            "visibility": {}
          },
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        },
      );
    } catch (err3) {
      if (err3.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        error.data = err3.response.data; // Error data sent by the server
        error.status = err3.response.status; // HTTP status code (e.g., 404, 500)
        error.headers = err3.response.headers; // Response headers
      }

      if (err3.request) {
        // The request was made but no response was received
        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
        // http.ClientRequest in node.js
        error.request = err3.request;
      }

      if (err3.message) {
        // Something happened in setting up the request that triggered an Error
        error.message = err3.message;
      }

      if (err3.config) {
        error.config = err3.config;
      }
    }

    return res
      .setHeader('content-type', 'application/json')
      .status(200)
      .send(JSON.stringify({
        token,
        issueIdOrKey,
        commentContent,
        error,
        rawResponseData: (rawResponse && rawResponse.data) ?
          rawResponse.data : null
      }))
  });

  app.listen(port, '0.0.0.0', () => {
    console.log('app is listening on port 3000; allows requests from 0.0.0.0;');
  });

})();
