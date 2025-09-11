// Lambda resolver for generateRecipe using AWS SigV4 + https (no external deps)
// Returns: { body: string, error: string }

import https from 'node:https';
import crypto from 'node:crypto';

const REGION = 'us-east-1';
const SERVICE = 'bedrock';
const HOST = `bedrock-runtime.${REGION}.amazonaws.com`;
const MODEL_ID = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
// Image model: choose a commonly available Bedrock model
// You can switch to Titan or SDXL depending on your account access
const IMAGE_MODEL_ID = 'stability.stable-diffusion-xl-v1';

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

function extractJson(text) {
  try {
    const trimmed = String(text || '').trim();
    // Remove Markdown code fences if present
    const fenceMatch = trimmed.match(/```(?:json)?([\s\S]*?)```/i);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : trimmed;
    return JSON.parse(jsonStr);
  } catch (_e) {
    return null;
  }
}

async function invokeTextModel(ingredients) {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are a helpful chef and a discerning food expert. Your task is to create a recipe from a given list of ingredients.

First, evaluate the ingredients:
- Are they real, edible food items?
- Can a sensible recipe be made from them?

Produce output strictly as minified JSON with three fields: "recipe", "image_prompt", and "error".

- If the ingredients are valid and a recipe can be made:
  - "recipe": A complete, well-formatted Markdown string with title, servings, ingredients with amounts, and numbered steps.
  - "image_prompt": A 1-2 sentence photorealistic description of the final plated dish for a text-to-image model.
  - "error": null

- If the ingredients are nonsensical, unreal, or cannot be combined into a reasonable dish:
  - "recipe": null
  - "image_prompt": null
  - "error": A string explaining why a recipe cannot be created (e.g., "Ingredients are not valid food items.").

Ingredients to use:
${ingredients.join(', ')}

Output ONLY the JSON object without any commentary.

\n\nHuman: Here are my ingredients: ${ingredients.join(', ')}\n\nAssistant:`,
          },
        ],
      },
    ],
  };
  const body = JSON.stringify(payload);

  const rawPath = `/model/${MODEL_ID}/invoke`;
  const headers = signBedrockRequest(rawPath, body);
  const res = await httpsRequest({ method: 'POST', host: HOST, path: rawPath, headers }, body);

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
    return { text: '', error: 'Bedrock text error: status ' + String(res.statusCode) + (snippet ? ' - ' + snippet : '') };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch (e) {
    return { text: '', error: 'Failed to parse Bedrock text response JSON' };
  }

  let outText = '';
  if (parsed && parsed.content && Array.isArray(parsed.content) && parsed.content.length > 0) {
    const c0 = parsed.content[0];
    if (c0 && typeof c0.text === 'string') outText = c0.text;
  }

  if (!outText) {
    return { text: '', imagePrompt: '', error: 'Unexpected Bedrock text response format' };
  }

  const modelJson = extractJson(outText);
  if (!modelJson) {
    return { text: '', imagePrompt: '', error: 'Text model did not return valid JSON' };
  }

  if (modelJson.error) {
    return { text: '', imagePrompt: '', error: `Model error: ${modelJson.error}` };
  }

  if (typeof modelJson.recipe === 'string' && typeof modelJson.image_prompt === 'string') {
    return { text: String(modelJson.recipe), imagePrompt: String(modelJson.image_prompt), error: '' };
  }

  return { text: '', imagePrompt: '', error: 'Text model did not return expected recipe/image_prompt fields' };
}

async function invokeImageModel(prompt) {
  // Use the recipe-derived prompt
  const foodPrompt = `${prompt} Professional food photography, natural light, shallow depth of field, appetizing, restaurant plating.`;

  // Stability SDXL payload for Bedrock
  const payload = {
    text_prompts: [
      { text: foodPrompt },
      { text: 'low quality, blurry, watermark, text, logo, duplicate', weight: -1 },
    ],
    cfg_scale: 7,
    steps: 40,
    samples: 1,
    width: 512,
    height: 512,
    clip_guidance_preset: 'FAST_BLUE',
  };
  const body = JSON.stringify(payload);

  const rawPath = `/model/${IMAGE_MODEL_ID}/invoke`;
  const headers = signBedrockRequest(rawPath, body);
  const res = await httpsRequest({ method: 'POST', host: HOST, path: rawPath, headers }, body);

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
    return { base64: '', mime: '', error: 'Bedrock image error: status ' + String(res.statusCode) + (snippet ? ' - ' + snippet : '') };
  }

  try {
    const json = JSON.parse(res.body || '{}');
    // Stability returns { artifacts: [{ base64, ... }] }
    const b64 = json && json.artifacts && Array.isArray(json.artifacts) && json.artifacts[0] && json.artifacts[0].base64 ? json.artifacts[0].base64 : '';
    if (!b64) return { base64: '', mime: '', error: 'Unexpected Bedrock image response format' };
    return { base64: b64, mime: 'image/png', error: '' };
  } catch (e) {
    // If not JSON, some models return binary—fallback not handled here
    return { base64: '', mime: '', error: 'Failed to parse Bedrock image response JSON' };
  }
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

    // 1) Generate recipe text and a matching image prompt
    const textRes = await invokeTextModel(safeIngredients);
    if (textRes.error) {
      return { body: '', error: textRes.error };
    }

    // 2) Generate an image for the recipe using the model-provided image prompt
    const imgRes = await invokeImageModel(textRes.imagePrompt || '');
    // Even if image fails, return text with image error in error field
    const errorMsg = imgRes.error ? `Image: ${imgRes.error}` : '';
    return { body: String(textRes.text), imageBase64: imgRes.base64 || '', imageMimeType: imgRes.mime || '', error: errorMsg };
  } catch (err) {
    return { body: '', error: 'Handler error: ' + String(err && err.message ? err.message : err) };
  }
}
