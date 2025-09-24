/**
 * Qwen API to OpenAI Standard - Single File Deno Deploy/Playground Script
 *
 * @version 2.3
 * @description This script acts as a proxy, converting standard OpenAI API requests
 * into the proprietary format used by `chat.qwen.ai` and transforms the response
 * back into the standard OpenAI format. It incorporates the specific logic
 * found in the original Qwen2API Node.js repository.
 *
 *
 * --- DEPLOYMENT INSTRUCTIONS ---
 *
 * 1. **Deno Deploy / Playground Setup**:
 *    - Create a new project in Deno Deploy.
 *    - Copy and paste this entire script into the editor.
 *
 * 2. **Set Environment Variables**:
 *    In your Deno Deploy project settings, add the following environment variables:
 *
 *    - `OPENAI_API_KEY`: (Recommended) Your secret key for clients to access this proxy.
 *                        If not set, the proxy will be open to the public.
 *                        Example: `sk-my-secret-key-12345`
 *
 *    - `API_KEY`: Your Qwen account token(s) for the upstream API. You can provide
 *                 multiple tokens separated by commas. The script will rotate through them.
 *                 This is a **required** variable.
 *                 Example: `ey...abc,ey...def`
 *
 *    - `SSXMOD_ITNA`: The special cookie value required for the upstream API.
 *                     This may be required for certain models or features.
 *                     Example: `mqUxRDBD...DYAEDBYD74G+DDeDixGm...`
 *
 * 3. **Run**:
 *    The script will automatically run upon deployment.
 *
 * --- LOCAL USAGE ---
 *
 * 1. Save this file as `main.ts`.
 * 2. Set environment variables in your terminal:
 *    export OPENAI_API_KEY="your_secret_proxy_key"
 *    export API_KEY="your_qwen_token"
 *    export SSXMOD_ITNA="your_cookie_value"
 * 3. Run the script:
 *    deno run --allow-net --allow-env main.ts
 *
 * --- ABOUT DENO ---
 * Deno is a modern and secure runtime for JavaScript and TypeScript.
 * - It has built-in support for TypeScript without a separate compilation step.
 * - It uses explicit permissions for file, network, and environment access.
 * - It has a standard library and a decentralized package management system using URLs.
 * This script is designed to be easily deployable on Deno's serverless platform, Deno Deploy.
 */

import { Application, Router, Context, Middleware } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { Buffer } from "https://deno.land/std@0.177.0/io/buffer.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";
import { decode } from "https://deno.land/std@0.208.0/encoding/base64.ts";


// --- 1.5. Qwen OSS Upload Logic ---

const UPLOAD_CONFIG = {
  stsTokenUrl: 'https://chat.qwen.ai/api/v1/files/getstsToken',
  maxRetries: 3,
  timeout: 30000,
};

/**
 * Requests a temporary STS Token from the Qwen API for file uploads.
 * Mimics the logic from `requestStsToken` in `upload.js`.
 */
async function requestStsToken(filename: string, filesize: number, filetype: string, authToken: string, retryCount = 0): Promise<any> {
    const bearerToken = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
    const payload = { filename, filesize, filetype };

    try {
        const response = await fetch(UPLOAD_CONFIG.stsTokenUrl, {
            method: 'POST',
            headers: {
                'Authorization': bearerToken,
                'Content-Type': 'application/json',
                'x-request-id': crypto.randomUUID(),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            body: JSON.stringify(payload),
        });

        if (response.ok) {
            const stsData = await response.json();
            // Basic validation
            if (stsData.access_key_id && stsData.file_url && stsData.bucketname) {
                return stsData;
            }
            throw new Error("Incomplete STS token response received.");
        }

        throw new Error(`Failed to get STS token: ${response.status} ${response.statusText}`);

    } catch (error) {
        if (retryCount < UPLOAD_CONFIG.maxRetries) {
            console.warn(`STS token request failed, retrying (${retryCount + 1}/${UPLOAD_CONFIG.maxRetries})...`, error.message);
            await new Promise(res => setTimeout(res, 1000 * Math.pow(2, retryCount)));
            return requestStsToken(filename, filesize, filetype, authToken, retryCount + 1);
        }
        console.error("Failed to get STS token after multiple retries.", error);
        throw error;
    }
}

/**
 * Uploads a file to Qwen's Alibaba Cloud OSS using STS credentials.
 * @param fileBuffer The file content as a Uint8Array.
 * @param originalFilename The original name of the file.
 * @param qwenAuthToken The Qwen authorization token.
 * @returns The URL and ID of the uploaded file.
 */
async function uploadFileToQwenOss(fileBuffer: Uint8Array, originalFilename: string, qwenAuthToken: string): Promise<{ file_url: string, file_id: string }> {
    const filesize = fileBuffer.length;
    const mimeType = originalFilename.endsWith('.png') ? 'image/png' :
                     originalFilename.endsWith('.jpg') || originalFilename.endsWith('.jpeg') ? 'image/jpeg' :
                     'application/octet-stream';
    const filetypeSimple = mimeType.startsWith('image/') ? 'image' : 'file';

    // 1. Get STS Token
    const stsData = await requestStsToken(originalFilename, filesize, filetypeSimple, qwenAuthToken);

    const stsCredentials = {
        accessKeyID: stsData.access_key_id,
        secretKey: stsData.access_key_secret,
        sessionToken: stsData.security_token,
    };
    const ossInfo = {
        bucket: stsData.bucketname,
        endpoint: stsData.region + '.aliyuncs.com',
        path: stsData.file_path,
        region: stsData.region,
    };

    // 2. Upload to OSS using S3Client from s3_lite_client
    const s3Client = new S3Client({
        accessKeyID: stsCredentials.accessKeyID,
        secretKey: stsCredentials.secretKey,
        sessionToken: stsCredentials.sessionToken,
        bucket: ossInfo.bucket,
        region: ossInfo.region,
        endpointURL: `https://${ossInfo.endpoint}`,
    });

    await s3Client.putObject(ossInfo.path, fileBuffer, {
        contentType: mimeType,
    });

    return {
        file_url: stsData.file_url,
        file_id: stsData.file_id,
    };
}


// --- 1. Configuration from Environment Variables ---

const config = {
    openaiApiKey: Deno.env.get("OPENAI_API_KEY") || "",
    apiKeys: (Deno.env.get("API_KEY") || "").split(',').map(k => k.trim()).filter(Boolean),
    ssxmodItna: Deno.env.get("SSXMOD_ITNA") || "",
};

if (config.apiKeys.length === 0) {
    console.error("FATAL: API_KEY environment variable is not set or empty. This is required for the upstream Qwen API.");
    Deno.exit(1);
}

if (!config.openaiApiKey) {
    console.warn("WARNING: OPENAI_API_KEY is not set. The proxy will be open to the public.");
}

// Simple token rotator for upstream API
let tokenIndex = 0;
function getUpstreamToken(): string {
    if (config.apiKeys.length === 0) return "";
    const token = config.apiKeys[tokenIndex];
    tokenIndex = (tokenIndex + 1) % config.apiKeys.length;
    return token;
}

// --- 2. Core Conversion Logic (from original Node.js project analysis) ---

/**
 * Asynchronously processes OpenAI messages to handle multimodal content for Qwen.
 * If a base64 image is found, it's uploaded to OSS, and the message content is updated.
 * @param messages The array of messages from the OpenAI request.
 * @param qwenAuthToken The token needed to authenticate with the Qwen upload API.
 * @returns A promise that resolves to a new array of messages formatted for Qwen.
 */
async function processMessagesForQwen(messages: any[], qwenAuthToken: string): Promise<any[]> {
    if (!messages || !Array.isArray(messages)) {
        return [];
    }

    const processedMessages = [];
    for (const message of messages) {
        if (message.role === 'user' && Array.isArray(message.content)) {
            const newContent = [];
            let hasImage = false;

            for (const part of message.content) {
                if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
                    hasImage = true;
                    const base64Data = part.image_url.url;
                    const match = base64Data.match(/^data:(image\/\w+);base64,(.*)$/);
                    if (!match) {
                        console.warn("Skipping invalid base64 image data.");
                        newContent.push({ type: 'text', text: '[Invalid Image Data]' });
                        continue;
                    }

                    const [, mimeType, base64] = match;
                    const fileExtension = mimeType.split('/')[1] || 'png';
                    const filename = `${crypto.randomUUID()}.${fileExtension}`;
                    const buffer = decode(base64);

                    try {
                        const uploadResult = await uploadFileToQwenOss(buffer, filename, qwenAuthToken);
                        // Replace with Qwen's expected format for uploaded images
                        newContent.push({ type: 'image', image: uploadResult.file_url });
                    } catch (e) {
                        console.error("Failed to upload image to Qwen OSS:", e);
                        newContent.push({ type: 'text', text: `[Image upload failed: ${e.message}]` });
                    }
                } else if (part.type === 'image_url') {
                    // It's a regular URL, convert to markdown format as a fallback.
                    newContent.push({ type: 'text', text: `![]( ${part.image_url.url} )` });
                } else {
                    newContent.push(part);
                }
            }
            // If there was an image, Qwen expects content to be an array.
            // If not, it should be a string. This logic might need refinement based on Qwen API behavior.
            if (hasImage) {
                 // Flatten text parts into a single string if mixed with images
                const flattenedContent = [];
                let textParts = [];
                for(const item of newContent) {
                    if (item.type === 'text') {
                        textParts.push(item.text);
                    } else {
                        if (textParts.length > 0) {
                            flattenedContent.push({ type: 'text', text: textParts.join('\n') });
                            textParts = [];
                        }
                        flattenedContent.push(item);
                    }
                }
                if (textParts.length > 0) {
                    flattenedContent.push({ type: 'text', text: textParts.join('\n') });
                }
                processedMessages.push({ ...message, content: flattenedContent });
            } else {
                 // No images, just combine text parts into a single string.
                const combinedText = message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
                processedMessages.push({ ...message, content: combinedText });
            }

        } else {
            processedMessages.push(message);
        }
    }
    return processedMessages;
}


/**
 * Transforms an OpenAI-formatted request body into the proprietary Qwen format.
 * This function mimics the logic from `processRequestBody` in `chat-middleware.js`.
 * @param openAIRequest The incoming request body.
 * @returns A request body for the `chat.qwen.ai` API.
 */
function transformOpenAIRequestToQwen(openAIRequest: any): any {
    const model = openAIRequest.model || "qwen-max";

    // Determine chat_type from model suffix
    let chat_type = 't2t';
    if (model.includes('-search')) chat_type = 'search';
    if (model.includes('-image')) chat_type = 't2i';
    if (model.includes('-video')) chat_type = 't2v';

    // Clean the model name
    const qwenModel = model.replace(/-search|-thinking|-image|-video/g, '');

    const qwenBody = {
        "model": qwenModel,
        "messages": openAIRequest.messages, // Messages are now pre-processed
        "stream": true,
        "incremental_output": true,
        "chat_type": chat_type,
        "session_id": crypto.randomUUID(),
        "chat_id": crypto.randomUUID(),
        "feature_config": {
            "output_schema": "phase",
            "thinking_enabled": model.includes('-thinking'),
        }
    };

    return qwenBody;
}

/**
 * Creates a TransformStream to convert the Qwen SSE response stream
 * into an OpenAI-compatible SSE stream.
 * This mimics the logic from `handleStreamResponse` in `chat.js`.
 */
function createQwenToOpenAIStreamTransformer(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const messageId = crypto.randomUUID();

    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });

            const lines = buffer.split('\n\n');
            buffer = lines.pop() || ''; // Keep partial line

            for (const line of lines) {
                if (!line.startsWith('data:')) continue;

                try {
                    const qwenChunk = JSON.parse(line.substring(5));
                    if (!qwenChunk.choices || qwenChunk.choices.length === 0) continue;

                    const delta = qwenChunk.choices[0].delta;
                    if (!delta) continue;

                    let content = delta.content || "";

                    // Handle special <think> tags
                    if (delta.phase === 'think' && !buffer.includes('<think>')) {
                        content = `<think>\n${content}`;
                    }
                    if (delta.phase === 'answer' && buffer.includes('<think>') && !buffer.includes('</think>')) {
                        content = `\n</think>\n${content}`;
                    }

                    const openAIChunk = {
                        id: `chatcmpl-${messageId}`,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: qwenChunk.model || "qwen",
                        choices: [{
                            index: 0,
                            delta: { content: content },
                            finish_reason: qwenChunk.choices[0].finish_reason || null,
                        }],
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                } catch (e) {
                    console.error("Error parsing Qwen stream chunk:", e);
                }
            }
        },
        flush(controller) {
            // Send the final DONE message
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        },
    });
}

// --- 3. Oak Application and Routes ---

const app = new Application();
const router = new Router();

// Middleware for logging and error handling
app.use(async (ctx, next) => {
    try {
        await next();
    } catch (err) {
        console.error(`Unhandled error: ${err.message}`);
        ctx.response.status = 500;
        ctx.response.body = { error: "Internal Server Error" };
    }
    console.log(`${ctx.request.method} ${ctx.request.url} - ${ctx.response.status}`);
});

// Middleware for Authentication
const authMiddleware: Middleware = async (ctx, next) => {
    // Skip auth for the root informational page
    if (ctx.request.url.pathname === '/') {
        await next();
        return;
    }

    if (!config.openaiApiKey) {
        // If no key is configured on the server, allow requests but log a warning.
        await next();
        return;
    }

    const authHeader = ctx.request.headers.get("Authorization");
    const clientToken = authHeader?.replace(/^Bearer\s+/, '');

    if (clientToken === config.openaiApiKey) {
        await next();
    } else {
        ctx.response.status = 401;
        ctx.response.body = { error: "Unauthorized. Invalid API key provided." };
    }
};

/**
 * GET / (Root)
 * Serves a simple informational HTML page.
 */
router.get("/", (ctx: Context) => {
    const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Qwen API Proxy</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 40px; background-color: #121212; color: #E0E0E0; }
                h1, h2 { color: #BB86FC; border-bottom: 2px solid #373737; padding-bottom: 10px; }
                code { background-color: #333; padding: 2px 6px; border-radius: 4px; font-family: "Courier New", Courier, monospace; }
                p { line-height: 1.6; }
                a { color: #03DAC6; text-decoration: none; }
                a:hover { text-decoration: underline; }
                .container { max-width: 800px; margin: 0 auto; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 Qwen API Proxy</h1>
                <p>This server acts as a proxy to convert standard OpenAI API requests into the proprietary format for the Qwen Chat API.</p>
                
                <h2>Available API Endpoints</h2>
                <ul>
                    <li><code>GET /v1/models</code> - Retrieves a list of available models.</li>
                    <li><code>POST /v1/chat/completions</code> - The main endpoint for chat, supporting streaming.</li>
                </ul>

                <h2>Source Code</h2>
                <p>The original source code for this project can be found at:</p>
                <p><a href="https://github.com/highkay/qwenchat2api" target="_blank">https://github.com/highkay/qwenchat2api</a></p>
            </div>
        </body>
        </html>
    `;
    ctx.response.body = htmlContent;
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
});

/**
 * GET /v1/models
 * Fetches the model list from Qwen and adds special variants.
 */
router.get("/v1/models", async (ctx: Context) => {
    const token = getUpstreamToken();
    if (!token) {
        ctx.response.status = 503;
        ctx.response.body = { error: "Upstream token not configured." };
        return;
    }

    try {
        const response = await fetch('https://chat.qwen.ai/api/models', {
            headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.statusText}`);
        }

        const originalModels = (await response.json()).data;
        const processedModels: any[] = [];

        for (const model of originalModels) {
            processedModels.push(model);
            // Add special variants based on original project logic
            if (model?.info?.meta?.abilities?.thinking) {
                processedModels.push({ ...model, id: `${model.id}-thinking` });
            }
            if (model?.info?.meta?.chat_type?.includes('search')) {
                processedModels.push({ ...model, id: `${model.id}-search` });
            }
             if (model?.info?.meta?.chat_type?.includes('t2i')) {
                processedModels.push({ ...model, id: `${model.id}-image` });
            }
        }

        ctx.response.body = { object: "list", data: processedModels };
    } catch (err) {
        console.error("Error fetching models:", err.message);
        ctx.response.status = 502;
        ctx.response.body = { error: "Failed to fetch models from upstream API." };
    }
});

/**
 * POST /v1/chat/completions
 * The main chat proxy endpoint.
 */
router.post("/v1/chat/completions", async (ctx: Context) => {
    const token = getUpstreamToken();
    if (!token) {
        ctx.response.status = 503;
        ctx.response.body = { error: "Upstream token not configured." };
        return;
    }

    try {
        const openAIRequest = await ctx.request.body({ type: "json" }).value;

        // Asynchronously process messages for file uploads before transforming the request
        openAIRequest.messages = await processMessagesForQwen(openAIRequest.messages, token);

        const qwenRequest = transformOpenAIRequestToQwen(openAIRequest);

        const headers: Record<string, string> = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        };
        if (config.ssxmodItna) {
            headers['Cookie'] = `ssxmod_itna=${config.ssxmodItna}`;
        }

        const upstreamResponse = await fetch("https://chat.qwen.ai/api/chat/completions", {
            method: "POST",
            headers: headers,
            body: JSON.stringify(qwenRequest),
        });

        if (!upstreamResponse.ok || !upstreamResponse.body) {
            const errorBody = await upstreamResponse.text();
            console.error(`Upstream API error: ${upstreamResponse.status}`, errorBody);
            ctx.response.status = upstreamResponse.status;
            ctx.response.body = { error: "Upstream API request failed", details: errorBody };
            return;
        }

        // Transform the response stream and send it to the client
        const transformedStream = upstreamResponse.body.pipeThrough(createQwenToOpenAIStreamTransformer());

        ctx.response.body = transformedStream;
        ctx.response.headers.set("Content-Type", "text/event-stream");
        ctx.response.headers.set("Cache-Control", "no-cache");
        ctx.response.headers.set("Connection", "keep-alive");

    } catch (err) {
        console.error("Error in chat completions proxy:", err.message);
        ctx.response.status = 500;
        ctx.response.body = { error: "Internal Server Error" };
    }
});

// Apply middleware
app.use(authMiddleware);
app.use(router.routes());
app.use(router.allowedMethods());

// --- 4. Start Server ---

app.addEventListener("listen", ({ hostname, port }) => {
    console.log(`🚀 Server listening on http://${hostname ?? "localhost"}:${port}`);
    console.log("Reading environment variables...");
    if (config.openaiApiKey) {
        console.log("✅ OPENAI_API_KEY is set. Authentication is ENABLED.");
    } else {
        console.log("⚠️ OPENAI_API_KEY is NOT set. Authentication is DISABLED.");
    }
    console.log(config.apiKeys.length > 0 ? "✅ API_KEY (for upstream) is set." : "❌ API_KEY (for upstream) is NOT set.");
    console.log(config.ssxmodItna ? "✅ SSXMOD_ITNA (cookie) is set." : "⚠️ SSXMOD_ITNA (cookie) is NOT set.");
});

await app.listen({ port: 8000 });