// Lambda resolver for askBedrock using AWS SigV4 + https (no external deps)
// Returns: { body: string, error: string }

const https = require('https');
const crypto = require('crypto');

const REGION = 'us-east-1';
const SERVICE = 'bedrock';
const HOST = `bedrock-runtime.${REGION}.amazonaws.com`;
const MODEL_ID = 'anthropic.claude-3-5-sonnet-20240620-v1:0';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function getSigningKey(secretAccessKey, date, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

function signBedrockRequest(path, body) {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
  const sessionToken = process.env.AWS_SESSION_TOKEN || '';
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS credentials in environment');
  }

  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const method = 'POST';
  const canonicalUri = path;
  const canonicalQuerystring = '';

  const headers = {
    'content-type': 'application/json',
    host: HOST,
    'x-amz-date': amzDate,
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => k.toLowerCase() + ':' + String(headers[k]).trim() + '\n')
    .join('');
  const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');
  const payloadHash = sha256Hex(body);

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const signingKey = getSigningKey(secretAccessKey, dateStamp, REGION, SERVICE);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders = {
    Host: HOST,
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    Authorization: authorizationHeader,
  };
  if (sessionToken) requestHeaders['X-Amz-Security-Token'] = sessionToken;

  return requestHeaders;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode || 0, body: buf.toString('utf-8') });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  // Quick wiring check: uncomment return below to verify Lambda is invoked
  // return { body: 'lambda-live', error: '' };
  try {
    const args = event && event.arguments ? event.arguments : {};
    const ingredients = Array.isArray(args.ingredients) ? args.ingredients : [];

    const safeIngredients = [];
    for (let i = 0; i < ingredients.length; i++) {
      const v = ingredients[i];
      if (typeof v === 'string') {
        const t = v.trim();
        if (t.length > 0) safeIngredients.push(t);
      }
    }

    const prompt = 'Suggest a recipe idea using these ingredients: ' + safeIngredients.join(', ') + '.';
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '\n\nHuman: ' + prompt + '\n\nAssistant:' }],
        },
      ],
    };
    const body = JSON.stringify(payload);

    const path = `/model/${MODEL_ID}/invoke`;
    const headers = signBedrockRequest(path, body);
    const res = await httpsRequest({ method: 'POST', host: HOST, path, headers }, body);

    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { body: '', error: 'Bedrock error: status ' + String(res.statusCode) };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.body || '{}');
    } catch (e) {
      return { body: '', error: 'Failed to parse Bedrock response JSON' };
    }

    let outText = '';
    if (parsed && parsed.content && Array.isArray(parsed.content) && parsed.content.length > 0) {
      const c0 = parsed.content[0];
      if (c0 && typeof c0.text === 'string') outText = c0.text;
    }

    if (!outText) {
      return { body: '', error: 'Unexpected Bedrock response format' };
    }

    return { body: String(outText), error: '' };
  } catch (err) {
    return { body: '', error: 'Handler error: ' + String(err && err.message ? err.message : err) };
  }
};
