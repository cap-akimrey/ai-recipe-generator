// Lambda resolver for generateRecipe using AWS SigV4 + https (no external deps)
// Returns: { body: string, error: string }

import https from 'node:https';
import crypto from 'node:crypto';

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

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function canonicalizePath(path) {
  // Preserve leading slash by keeping empty first segment
  const parts = path.split('/');
  const encoded = parts.map((seg) => encodeRfc3986(seg));
  return encoded.join('/');
}

function signBedrockRequest(path, body) {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
  const sessionToken = process.env.AWS_SESSION_TOKEN || '';
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS credentials in environment');
  }

  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z'; // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const method = 'POST';
  const canonicalUri = canonicalizePath(path);
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

  return { headers: requestHeaders, canonicalPath: canonicalUri };
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

export async function handler(event) {
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

    const rawPath = `/model/${MODEL_ID}/invoke`;
    const signed = signBedrockRequest(rawPath, body);
    const res = await httpsRequest({ method: 'POST', host: HOST, path: signed.canonicalPath, headers: signed.headers }, body);

    if (res.statusCode < 200 || res.statusCode >= 300) {
      let detail = '';
      try {
        const errJson = JSON.parse(res.body || '{}');
        const code = errJson.__type || errJson.code || errJson.error || '';
        const msg = errJson.message || errJson.Message || JSON.stringify(errJson);
        detail = (code ? code + ': ' : '') + msg;
      } catch (_e) {
        detail = res.body || '';
      }
      const snippet = String(detail).slice(0, 500);
      return { body: '', error: 'Bedrock error: status ' + String(res.statusCode) + (snippet ? ' - ' + snippet : '') };
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
}
