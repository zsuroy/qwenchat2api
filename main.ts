/**
 * Qwen API to OpenAI Standard - Single File Deno Deploy/Playground Script
 *
 * @version 3.9
 * @description Fixed duplicate image URLs in stream response
 * 
 * FIXES in v3.9:
 * - Prevent duplicate image URLs in streaming response
 * - Track already sent image URLs
 * - Only send unique image URLs once
 * - Better handling of image generation completion
 */

import { Application, Router, Context, Middleware } from "https://deno.land/x/oak@v12.6.1/mod.ts";

// ============================================================================
// Logger Class - Enhanced Logging System
// ============================================================================
class Logger {
  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private formatDuration(startTime: number): string {
    return `${Date.now() - startTime}ms`;
  }

  private sanitizeHeaders(headers: Headers): Record<string, string> {
    const sanitized: Record<string, string> = {};
    headers.forEach((value, key) => {
      if (key.toLowerCase() === 'authorization') {
        sanitized[key] = value.substring(0, 20) + '...';
      } else if (key.toLowerCase() === 'cookie') {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    });
    return sanitized;
  }

  info(message: string, data?: any) {
    console.log(`[${this.formatTimestamp()}] INFO: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  error(message: string, error?: any, data?: any) {
    console.error(`[${this.formatTimestamp()}] ERROR: ${message}`, {
      error: error?.message || error,
      stack: error?.stack,
      ...data
    });
  }

  debug(message: string, data?: any) {
    if (Deno.env.get("DEBUG") === "true") {
      console.log(`[${this.formatTimestamp()}] DEBUG: ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }

  request(ctx: Context, startTime: number) {
    const duration = this.formatDuration(startTime);
    const logData = {
      timestamp: this.formatTimestamp(),
      method: ctx.request.method,
      path: ctx.request.url.pathname,
      query: Object.fromEntries(ctx.request.url.searchParams),
      status: ctx.response.status,
      duration,
      headers: this.sanitizeHeaders(ctx.request.headers),
      ip: ctx.request.ip,
      userAgent: ctx.request.headers.get('user-agent'),
    };
    
    const level = ctx.response.status >= 400 ? 'ERROR' : 'INFO';
    console.log(`[${this.formatTimestamp()}] ${level}: ${ctx.request.method} ${ctx.request.url.pathname} - ${ctx.response.status} (${duration})`, logData);
  }

  streamChunk(type: string, content: any) {
    console.log(`[${this.formatTimestamp()}] STREAM: ${type}`, { 
      contentLength: content?.length || 0,
      preview: typeof content === 'string' ? content.substring(0, 200) : JSON.stringify(content).substring(0, 200)
    });
  }
}

const logger = new Logger();

// ============================================================================
// Configuration from Environment Variables
// ============================================================================
const config = {
  salt: Deno.env.get("SALT") || "",
  useDenoEnv: Deno.env.get("USE_DENO_ENV")?.toLowerCase() === 'true',
  qwenTokenEnv: Deno.env.get("QWEN_TOKEN") || "",
  ssxmodItnaEnv: Deno.env.get("SSXMOD_ITNA_VALUE") || "",
  debug: Deno.env.get("DEBUG")?.toLowerCase() === 'true',
};

// ============================================================================
// Core Conversion Logic
// ============================================================================
const QWEN_API_BASE_URL = "https://chat.qwen.ai/api/v2/chat/completions";
const QWEN_CHAT_NEW_URL = "https://chat.qwen.ai/api/v2/chats/new";

// Helper function to create a new chat session
async function createNewChat(token: string, model: string, chatType: string): Promise<string | null> {
  try {
    logger.info(`Creating new chat session`, { model, chatType });
    
    const response = await fetch(QWEN_CHAT_NEW_URL, {
      method: "POST",
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        "title": "New Chat",
        "models": [model],
        "chat_mode": "normal",
        "chat_type": chatType,
        "timestamp": Date.now()
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to create new chat`, { status: response.status, error: errorText });
      return null;
    }

    const data = await response.json();
    const chatId = data?.data?.id || null;
    
    if (chatId) {
      logger.info(`Successfully created new chat`, { chatId });
    } else {
      logger.error(`No chat ID in response`, data);
    }
    
    return chatId;
  } catch (error) {
    logger.error(`Error creating new chat`, error);
    return null;
  }
}

// Helper function to extract images from conversation history
function extractImagesFromHistory(messages: any[]): string[] {
  const images: string[] = [];
  
  // Iterate through all messages to find images
  for (const message of messages) {
    if (!message) continue;
    
    // Handle assistant messages with markdown images
    if (message.role === 'assistant' && typeof message.content === 'string') {
      // Extract markdown image URLs: ![...](url)
      const markdownImageRegex = /!\[.*?\]\((.*?)\)/g;
      const matches = message.content.matchAll(markdownImageRegex);
      for (const match of matches) {
        if (match[1]) {
          images.push(match[1]);
        }
      }
    }
    
    // Handle user messages with various content formats
    if (message.role === 'user') {
      // String content might contain markdown images
      if (typeof message.content === 'string') {
        const markdownImageRegex = /!\[.*?\]\((.*?)\)/g;
        const matches = message.content.matchAll(markdownImageRegex);
        for (const match of matches) {
          if (match[1]) {
            images.push(match[1]);
          }
        }
      }
      // Array content with image_url objects
      else if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === 'image_url' && item.image_url?.url) {
            images.push(item.image_url.url);
          } else if (item.type === 'image' && item.image) {
            images.push(item.image);
          }
        }
      }
    }
  }
  
  // Return last 3 images (most recent)
  return images.slice(-3);
}

// Helper function to calculate aspect ratio dynamically
function calculateAspectRatio(size: string): string {
  const [width, height] = size.split('x').map(Number);
  if (!width || !height) {
    logger.error(`Invalid size format: ${size}, defaulting to 1:1`);
    return "1:1";
  }
  
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const divisor = gcd(width, height);
  const aspectRatio = `${width/divisor}:${height/divisor}`;
  logger.info(`Calculated aspect ratio for ${size}: ${aspectRatio}`);
  return aspectRatio;
}

// Transform OpenAI request to Qwen format
// Returns transformed request and chat_id if needed
async function transformOpenAIRequestToQwen(openAIRequest: any, token: string): Promise<{ request: any, chatId: string | null }> {
  // Validate request
  if (!openAIRequest.messages || !Array.isArray(openAIRequest.messages)) {
    throw new Error("Invalid request: messages array is required");
  }

  if (openAIRequest.messages.length === 0) {
    throw new Error("Invalid request: messages array cannot be empty");
  }

  const model = openAIRequest.model || "qwen-max";
  let chat_type = 't2t'; // default text-to-text
  
  // Determine chat type based on model suffix
  if (model.endsWith('-image')) chat_type = 't2i';
  if (model.endsWith('-image_edit')) chat_type = 'image_edit';
  if (model.endsWith('-video')) chat_type = 't2v';
  
  // Remove known suffixes for base model name
  const qwenModel = model.replace(/-(search|thinking|image|image_edit|video)$/, '');
  
  logger.info(`Transforming OpenAI request`, {
    originalModel: model,
    qwenModel,
    chatType: chat_type,
    messageCount: openAIRequest.messages.length
  });

  // Handle image editing requests
  if (chat_type === 'image_edit') {
    const lastUserMessage = openAIRequest.messages?.filter((m: any) => m.role === 'user').pop();
    if (!lastUserMessage) {
      throw new Error("No user message found for image editing.");
    }

    // Create new chat session for image editing
    const chatId = await createNewChat(token, qwenModel, 'image_edit');
    if (!chatId) {
      throw new Error("Failed to create chat session for image editing");
    }

    // Extract text content from last user message
    let textContent = "";
    const currentMessageImages: string[] = [];

    if (typeof lastUserMessage.content === 'string') {
      textContent = lastUserMessage.content;
    } else if (Array.isArray(lastUserMessage.content)) {
      for (const item of lastUserMessage.content) {
        if (item.type === 'text') {
          textContent += item.text || item.content || '';
        } else if (item.type === 'image_url' && item.image_url?.url) {
          currentMessageImages.push(item.image_url.url);
        } else if (item.type === 'image' && item.image) {
          currentMessageImages.push(item.image);
        }
      }
    }

    // Extract images from conversation history (including assistant responses)
    const historyImages = extractImagesFromHistory(openAIRequest.messages.slice(0, -1));
    
    // Combine current message images with history images (current takes priority)
    const allImages = [...currentMessageImages, ...historyImages];
    const imagesToUse = allImages.slice(-3); // Use last 3 images max
    
    logger.info(`Image editing context`, {
      currentMessageImages: currentMessageImages.length,
      historyImages: historyImages.length,
      totalImages: allImages.length,
      usingImages: imagesToUse.length
    });

    // Build files array for the request
    const files: any[] = [];
    
    // If we have images, add them
    if (imagesToUse.length > 0) {
      // Use the most recent image as the primary edit target
      files.push({
        type: "image",
        url: imagesToUse[imagesToUse.length - 1]
      });
      
      logger.info(`Using image for editing: ${imagesToUse[imagesToUse.length - 1]}`);
    } else {
      // If no images in context, this becomes a text-to-image request
      logger.info(`No images found in context, switching to t2i mode`);
    }

    // Build request with chat_id
    const transformedRequest = {
      "stream": true,
      "incremental_output": true,
      "chat_id": chatId,
      "chat_mode": "normal",
      "model": qwenModel,
      "parent_id": null,
      "messages": [{
        "role": "user",
        "content": textContent || "Generate an image",
        "files": files,
        "chat_type": files.length > 0 ? "image_edit" : "t2i",
        "feature_config": { 
          "thinking_enabled": false,
          "output_schema": "phase" 
        },
        "extra": {
          "meta": {
            "subChatType": files.length > 0 ? "image_edit" : "t2i"
          }
        },
        "sub_chat_type": files.length > 0 ? "image_edit" : "t2i"
      }],
      "timestamp": Date.now()
    };

    logger.info(`Transformed to image editing request`, { 
      model: qwenModel,
      chatId,
      fileCount: files.length,
      actualChatType: transformedRequest.messages[0].chat_type
    });
    
    return { request: transformedRequest, chatId };
  }

  // Handle image generation requests
  if (chat_type === 't2i') {
    const lastUserMessage = openAIRequest.messages?.filter((m: any) => m.role === 'user').pop();
    if (!lastUserMessage) {
      throw new Error("No user message found for image generation.");
    }

    // Create new chat session for image generation
    const chatId = await createNewChat(token, qwenModel, 't2i');
    if (!chatId) {
      throw new Error("Failed to create chat session for image generation");
    }

    // Size mapping with extended options
    const openAISize = openAIRequest.size || "1024x1024";
    const sizeMap: Record<string, string> = {
      "256x256": "1:1",
      "512x512": "1:1",
      "1024x1024": "1:1",
      "1792x1024": "16:9",
      "1024x1792": "9:16",
      "2048x2048": "1:1",
      "1152x768": "3:2",
      "768x1152": "2:3",
    };
    
    let qwenSize = sizeMap[openAISize] || calculateAspectRatio(openAISize);

    // Extract text content
    let textContent = "";
    if (typeof lastUserMessage.content === 'string') {
      textContent = lastUserMessage.content;
    } else if (Array.isArray(lastUserMessage.content)) {
      for (const item of lastUserMessage.content) {
        if (item.type === 'text') {
          textContent += item.text || item.content || '';
        }
      }
    }

    // Build request with chat_id
    const transformedRequest = {
      "stream": true,
      "chat_id": chatId,
      "model": qwenModel,
      "size": qwenSize,
      "messages": [{
        "role": "user",
        "content": textContent || "Generate an image",
        "files": [],
        "chat_type": "t2i",
        "feature_config": { 
          "output_schema": "phase" 
        }
      }],
    };

    logger.info(`Transformed to image generation request`, { 
      size: qwenSize,
      model: qwenModel,
      chatId
    });
    
    return { request: transformedRequest, chatId };
  }

  // Default text generation request with session_id and chat_id
  const transformedRequest = {
    "model": qwenModel,
    "messages": openAIRequest.messages,
    "stream": true,
    "incremental_output": true,
    "chat_type": 'normal',
    "session_id": crypto.randomUUID(),
    "chat_id": crypto.randomUUID(),
    "feature_config": {
      "output_schema": "phase",
      "thinking_enabled": model.includes('-thinking'),
    }
  };

  logger.info(`Transformed to text generation request`, { 
    thinkingEnabled: model.includes('-thinking'),
    hasSessionId: true,
    hasChatId: true
  });
  
  return { request: transformedRequest, chatId: null };
}

// Stream transformer with enhanced error handling and duplicate prevention
function createQwenToOpenAIStreamTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const MAX_BUFFER_SIZE = 100000; // 100KB limit
  const messageId = crypto.randomUUID();
  let chunkCount = 0;
  let rawDataCount = 0;
  let errorDetected = false;
  
  // Track sent image URLs to prevent duplicates
  const sentImageUrls = new Set<string>();
  let lastImageUrl: string | null = null;
  let imageGenPhaseStarted = false;
  let imageGenPhaseFinished = false;

  return new TransformStream({
    transform(chunk, controller) {
      const rawChunk = decoder.decode(chunk, { stream: true });
      buffer += rawChunk;
      
      // Log raw data for debugging
      if (config.debug || rawDataCount < 3) {
        logger.debug(`Raw stream data (chunk ${++rawDataCount})`, {
          length: rawChunk.length,
          preview: rawChunk.substring(0, 500),
          hasData: rawChunk.includes('data:'),
          hasNewlines: rawChunk.includes('\n'),
        });
      }
      
      // Buffer overflow protection
      if (buffer.length > MAX_BUFFER_SIZE) {
        logger.error(`Buffer overflow detected (size: ${buffer.length}), clearing buffer`);
        buffer = '';
        return;
      }
      
      // Check for error responses
      if (!errorDetected && buffer.includes('"success":false')) {
        try {
          const errorJson = JSON.parse(buffer);
          if (errorJson.success === false) {
            logger.error("Upstream API returned error", errorJson);
            
            const errorMessage = errorJson.data?.details || errorJson.data?.code || "Unknown error from Qwen API";
            const openAIError = {
              id: `chatcmpl-${messageId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "qwen-proxy",
              choices: [{
                index: 0,
                delta: { 
                  content: `Error: ${errorMessage}\nRequest ID: ${errorJson.request_id}` 
                },
                finish_reason: "stop",
              }],
            };
            
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIError)}\n\n`));
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            errorDetected = true;
            buffer = '';
            return;
          }
        } catch (e) {
          // Not a complete JSON yet, continue buffering
        }
      }
      
      // Parse lines with multiple delimiter support
      let lines: string[] = [];
      
      if (buffer.includes('\n\n')) {
        lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
      } else if (buffer.includes('\n')) {
        lines = buffer.split('\n');
        const lastLine = lines[lines.length - 1];
        if (lastLine && !lastLine.startsWith('data:')) {
          buffer = lines.pop() || '';
        } else {
          buffer = '';
        }
      }

      for (const line of lines) {
        if (!line || line.trim() === '') continue;
        
        let dataStr = line;
        if (line.startsWith('data:')) {
          dataStr = line.substring(5).trim();
        } else if (line.startsWith('data: ')) {
          dataStr = line.substring(6).trim();
        }
        
        if (dataStr === '[DONE]') {
          logger.debug('Received [DONE] signal');
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          continue;
        }
        
        try {
          const qwenChunk = JSON.parse(dataStr);
          
          // Check for errors in chunk
          if (qwenChunk.success === false) {
            logger.error("Error in stream chunk", qwenChunk);
            const errorMessage = qwenChunk.data?.details || qwenChunk.data?.code || "Stream error";
            const openAIError = {
              id: `chatcmpl-${messageId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "qwen-proxy",
              choices: [{
                index: 0,
                delta: { content: `Error: ${errorMessage}` },
                finish_reason: "stop",
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIError)}\n\n`));
            errorDetected = true;
            continue;
          }
          
          // Log first few chunks for debugging
          if (chunkCount < 3 || config.debug) {
            logger.debug(`Parsed Qwen chunk ${chunkCount}`, qwenChunk);
          }
          
          // Extract content from various response structures
          let content = "";
          let isFinished = false;
          
          if (qwenChunk.choices && qwenChunk.choices.length > 0) {
            const choice = qwenChunk.choices[0];
            const delta = choice.delta || choice.message;
            
            if (delta) {
              content = delta.content || "";
              
              // Handle image generation phase
              if (delta.phase === 'image_gen') {
                if (!imageGenPhaseStarted) {
                  imageGenPhaseStarted = true;
                  logger.info(`Image generation phase started`);
                }
                
                // Check if this is an image URL
                if (content && content.startsWith('https://')) {
                  // Check if we've already sent this URL
                  if (!sentImageUrls.has(content)) {
                    sentImageUrls.add(content);
                    lastImageUrl = content;
                    content = `![Image](${content})`;
                    logger.info(`New image URL detected and formatted`, { 
                      url: lastImageUrl,
                      totalImagesSent: sentImageUrls.size 
                    });
                  } else {
                    // Skip duplicate image URL
                    logger.debug(`Skipping duplicate image URL`, { url: content });
                    content = "";
                  }
                } else if (content === "") {
                  // Empty content during image_gen phase, skip
                  logger.debug(`Skipping empty content during image_gen phase`);
                }
              }
              // Handle image editing responses
              else if ((delta.chat_type === 't2i' || delta.chat_type === 'image_edit') && content.startsWith('https://')) {
                if (!sentImageUrls.has(content)) {
                  sentImageUrls.add(content);
                  lastImageUrl = content;
                  content = `![Image](${content})`;
                  logger.info(`Image URL detected and formatted`, { 
                    url: lastImageUrl,
                    chatType: delta.chat_type 
                  });
                } else {
                  logger.debug(`Skipping duplicate image URL`, { url: content });
                  content = "";
                }
              }
              
              // Check if phase is finished
              if (delta.status === 'finished') {
                isFinished = true;
                if (imageGenPhaseStarted) {
                  imageGenPhaseFinished = true;
                  logger.info(`Image generation phase finished`, { 
                    totalImages: sentImageUrls.size 
                  });
                }
              }
              
              isFinished = isFinished || choice.finish_reason === 'stop';
            }
          } else if (qwenChunk.content) {
            content = qwenChunk.content;
            // Check if it's an image URL
            if (content.startsWith('https://') && content.includes('cdn.qwenlm.ai')) {
              if (!sentImageUrls.has(content)) {
                sentImageUrls.add(content);
                lastImageUrl = content;
                content = `![Image](${content})`;
                logger.info(`Image URL detected in content field`, { url: lastImageUrl });
              } else {
                logger.debug(`Skipping duplicate image URL from content field`, { url: content });
                content = "";
              }
            }
            isFinished = qwenChunk.status === 'finished' || qwenChunk.finish_reason === 'stop';
          } else if (qwenChunk.result || qwenChunk.data) {
            const data = qwenChunk.result || qwenChunk.data;
            if (typeof data === 'string') {
              content = data;
            } else if (data.content) {
              content = data.content;
            }
          }

          // Send OpenAI formatted chunk only if there's content or it's finished
          if (content || isFinished) {
            const openAIChunk = {
              id: `chatcmpl-${messageId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "qwen-proxy",
              choices: [{
                index: 0,
                delta: { content: content },
                finish_reason: isFinished ? 'stop' : null,
              }],
            };
            
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            chunkCount++;
            
            if (chunkCount % 10 === 0 || chunkCount <= 3) {
              logger.info(`Processed ${chunkCount} stream chunks`);
            }
          }
        } catch (e) {
          // Handle non-JSON text
          if (dataStr && dataStr.trim() && !dataStr.startsWith('{')) {
            logger.debug(`Treating as raw text: ${dataStr.substring(0, 100)}`);
            const openAIChunk = {
              id: `chatcmpl-${messageId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "qwen-proxy",
              choices: [{
                index: 0,
                delta: { content: dataStr },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            chunkCount++;
          } else {
            logger.debug("Could not parse chunk", { 
              error: e.message,
              dataStr: dataStr.substring(0, 200) 
            });
          }
        }
      }
    },
    
    flush(controller) {
      // Process remaining buffer
      if (buffer.trim() && !errorDetected) {
        logger.debug(`Processing remaining buffer on flush: ${buffer.substring(0, 200)}`);
        
        try {
          const remaining = buffer.trim();
          const possibleError = JSON.parse(remaining);
          
          if (possibleError.success === false) {
            logger.error("Error in final buffer", possibleError);
            const errorMessage = possibleError.data?.details || possibleError.data?.code || "Final buffer error";
            const openAIError = {
              id: `chatcmpl-${messageId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "qwen-proxy",
              choices: [{
                index: 0,
                delta: { content: `Error: ${errorMessage}` },
                finish_reason: "stop",
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIError)}\n\n`));
          }
        } catch (e) {
          logger.debug(`Could not parse remaining buffer: ${e.message}`);
        }
      }
      
      if (!errorDetected) {
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      }
      
      logger.info(`Stream completed`, {
        totalChunks: chunkCount,
        totalImages: sentImageUrls.size,
        errorDetected,
        imageGenPhaseStarted,
        imageGenPhaseFinished
      });
    },
  });
}

// ============================================================================
// Oak Application Setup
// ============================================================================
const app = new Application();
const router = new Router();

// Global error handling middleware
app.use(async (ctx, next) => {
  const startTime = Date.now();
  
  try {
    await next();
  } catch (err: any) {
    logger.error(`Unhandled error in request ${ctx.request.method} ${ctx.request.url}`, err);
    ctx.response.status = err.status || 500;
    ctx.response.body = { 
      error: err.message || "Internal Server Error",
      timestamp: new Date().toISOString(),
      path: ctx.request.url.pathname
    };
  } finally {
    logger.request(ctx, startTime);
  }
});

// Authentication middleware
const authMiddleware: Middleware = async (ctx, next) => {
  // Skip auth for root endpoint
  if (ctx.request.url.pathname === '/') {
    await next();
    return;
  }
  
  logger.info(`Processing authentication for ${ctx.request.url.pathname}`);
  ctx.state = ctx.state || {};

  if (config.useDenoEnv) {
    // Server-side authentication mode
    const authHeader = ctx.request.headers.get("Authorization");
    
    if (config.salt) {
      const clientToken = authHeader?.replace(/^Bearer\s+/, '');
      if (clientToken !== config.salt) {
        logger.error("Authentication failed: Invalid salt value", { provided: clientToken?.substring(0, 10) });
        ctx.response.status = 401;
        ctx.response.body = {
          error: "Invalid salt value.",
          format: "Server is in environment mode. Use: Authorization: Bearer your_salt_value",
          salt_required: true
        };
        return;
      }
    }
    
    ctx.state.qwenToken = config.qwenTokenEnv;
    ctx.state.ssxmodItna = config.ssxmodItnaEnv;
    logger.info("Authentication successful (server-side mode)");
  } else {
    // Client-side authentication mode
    const authHeader = ctx.request.headers.get("Authorization");
    const clientToken = authHeader?.replace(/^Bearer\s+/, '');
    
    if (!clientToken) {
      const expectedFormat = config.salt ? "Bearer salt;qwen_token;ssxmod_itna" : "Bearer qwen_token;ssxmod_itna";
      logger.error("Authentication failed: No token provided");
      ctx.response.status = 401;
      ctx.response.body = { 
        error: "Unauthorized.", 
        format: `Use: ${expectedFormat}`, 
        salt_required: !!config.salt 
      };
      return;
    }

    const parts = clientToken.split(';');
    let qwenToken: string;
    let ssxmodItna: string;

    if (config.salt) {
      if (parts.length < 2) {
        logger.error("Authentication failed: Invalid token format");
        ctx.response.status = 401;
        ctx.response.body = { 
          error: "Invalid token format.", 
          format: "Use: Bearer salt;qwen_token;ssxmod_itna", 
          salt_required: true 
        };
        return;
      }
      
      if (parts[0]?.trim() !== config.salt) {
        logger.error("Authentication failed: Invalid salt", { provided: parts[0]?.substring(0, 10) });
        ctx.response.status = 401;
        ctx.response.body = { error: "Invalid salt value." };
        return;
      }
      
      qwenToken = parts[1]?.trim();
      ssxmodItna = parts[2]?.trim() || '';
    } else {
      qwenToken = parts[0]?.trim();
      ssxmodItna = parts[1]?.trim() || '';
    }

    if (!qwenToken) {
      logger.error("Authentication failed: Qwen token is missing");
      ctx.response.status = 401;
      ctx.response.body = { error: "Qwen token is required." };
      return;
    }
    
    ctx.state.qwenToken = qwenToken;
    ctx.state.ssxmodItna = ssxmodItna;
    logger.info("Authentication successful (client-side mode)");
  }
  
  await next();
};

// Apply authentication middleware
app.use(authMiddleware);

// ============================================================================
// Routes
// ============================================================================

// Home page
router.get("/", (ctx: Context) => {
  logger.info("Serving home page");
  
  let saltStatus = config.salt ? "🔒 受限访问模式" : "🎯 开放访问模式";
  let authFormat: string;
  let authMode: string;

  if (config.useDenoEnv) {
    authMode = "服务器端认证 (环境变量)";
    authFormat = config.salt 
      ? "Authorization: Bearer your_salt_value"
      : "Authorization header can be anything (e.g., Bearer dummy)";
  } else {
    authMode = "客户端认证 (请求头)";
    authFormat = config.salt
      ? "Authorization: Bearer salt_value;qwen_token;ssxmod_itna_value"
      : "Authorization: Bearer qwen_token;ssxmod_itna_value";
  }

  const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qwen API Proxy</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="font-sans min-h-screen flex items-center justify-center p-5 bg-gradient-to-br from-indigo-500 to-purple-600">
  <div class="w-full max-w-lg rounded-2xl bg-white/95 p-10 text-center shadow-2xl backdrop-blur-md">
    <div class="mb-3 flex items-center justify-center gap-2">
      <div class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></div>
      <div class="text-lg font-semibold text-gray-800">服务运行正常</div>
    </div>
    <div class="mb-8 text-sm leading-relaxed text-gray-500">欲买桂花同载酒，终不似，少年游</div>
    <div class="mb-8 text-left">
      <div class="mb-4 text-base font-semibold text-gray-700">API 端点</div>
      <div class="flex items-center justify-between border-b border-gray-100 py-3">
        <span class="text-sm text-gray-500">模型列表</span>
        <code class="font-mono rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800">/v1/models</code>
      </div>
      <div class="flex items-center justify-between py-3">
        <span class="text-sm text-gray-500">聊天完成</span>
        <code class="font-mono rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800">/v1/chat/completions</code>
      </div>
    </div>
    <div class="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-5 text-left">
      <div class="mb-2 text-sm font-semibold text-gray-700">认证方式</div>
      <div class="mb-1 text-xs font-medium text-emerald-600">${saltStatus}</div>
      <div class="mb-3 text-xs font-medium text-indigo-600">${authMode}</div>
      <div class="font-mono break-all rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-[12px] leading-snug text-gray-600">${authFormat}</div>
    </div>
    <div class="text-xs font-medium text-gray-400">
      <span class="text-indigo-500">Qwen API Proxy v3.9</span><br/>
      <span class="text-gray-400 mt-1">🎯 Fixed duplicate image URLs</span>
    </div>
  </div>
</body>
</html>`;

  ctx.response.body = htmlContent;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
});

// Models endpoint - ADDED image_edit suffix
router.get("/v1/models", async (ctx: Context) => {
  const token = ctx.state?.qwenToken;
  
  if (!token) {
    logger.error("Models endpoint: No Qwen token available");
    ctx.response.status = 401;
    ctx.response.body = { error: "Authentication failed. No Qwen token available." };
    return;
  }
  
  try {
    logger.info("Fetching models from Qwen API");
    
    const response = await fetch('https://chat.qwen.ai/api/models', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }
    
    const originalModels = (await response.json()).data;
    const processedModels: any[] = [];
    
    for (const model of originalModels) {
      processedModels.push(model);
      
      // Add variant models based on capabilities
      if (model?.info?.meta?.abilities?.thinking) {
        processedModels.push({ ...model, id: `${model.id}-thinking` });
      }
      if (model?.info?.meta?.chat_type?.includes('search')) {
        processedModels.push({ ...model, id: `${model.id}-search` });
      }
      if (model?.info?.meta?.chat_type?.includes('t2i')) {
        processedModels.push({ ...model, id: `${model.id}-image` });
        // Also add image_edit variant for models that support image generation
        processedModels.push({ ...model, id: `${model.id}-image_edit` });
      }
      // Some models might specifically support image_edit without t2i
      if (model?.info?.meta?.chat_type?.includes('image_edit')) {
        if (!processedModels.some(m => m.id === `${model.id}-image_edit`)) {
          processedModels.push({ ...model, id: `${model.id}-image_edit` });
        }
      }
    }
    
    logger.info(`Successfully fetched ${originalModels.length} models, processed to ${processedModels.length} models`);
    ctx.response.body = { object: "list", data: processedModels };
  } catch (err: any) {
    logger.error("Error fetching models", err);
    ctx.response.status = 502;
    ctx.response.body = { 
      error: "Failed to fetch models from upstream API.",
      details: err.message 
    };
  }
});

// Chat completions endpoint - Updated with image_edit support
router.post("/v1/chat/completions", async (ctx: Context) => {
  const token = ctx.state?.qwenToken;
  const ssxmodItna = ctx.state?.ssxmodItna;
  const requestId = crypto.randomUUID();
  
  logger.info(`Starting chat completion request`, { requestId });
  
  if (!token) {
    logger.error("Chat completions: No Qwen token available", { requestId });
    ctx.response.status = 401;
    ctx.response.body = { error: "Authentication failed. No Qwen token available." };
    return;
  }

  try {
    const openAIRequest = await ctx.request.body({ type: "json" }).value;
    
    logger.info(`Received OpenAI request`, {
      requestId,
      model: openAIRequest.model,
      messageCount: openAIRequest.messages?.length,
      hasSize: !!openAIRequest.size,
      stream: openAIRequest.stream
    });
    
    // Transform request and potentially create chat session
    const { request: qwenRequest, chatId } = await transformOpenAIRequestToQwen(openAIRequest, token);
    
    // Build URL - add chat_id as query param if we have one
    let apiUrl = QWEN_API_BASE_URL;
    if (chatId) {
      apiUrl = `${QWEN_API_BASE_URL}?chat_id=${chatId}`;
    }
    
    // Log transformed request for debugging
    logger.debug(`Qwen request payload`, qwenRequest);
    logger.info(`Using API URL: ${apiUrl}`);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'source': 'web',
      'x-request-id': requestId,
    };
    
    if (ssxmodItna) {
      headers['Cookie'] = `ssxmod_itna=${ssxmodItna}`;
    }

    logger.info(`Sending request to Qwen API`, { 
      requestId, 
      headers: Object.keys(headers),
      url: apiUrl,
      hasChatId: !!chatId,
      modelType: openAIRequest.model?.includes('-image_edit') ? 'image_edit' : 
                 openAIRequest.model?.includes('-image') ? 'image' : 'text'
    });
    
    const upstreamResponse = await fetch(apiUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(qwenRequest),
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const errorBody = await upstreamResponse.text();
      logger.error(`Upstream API error`, {
        requestId,
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        errorBody: errorBody.substring(0, 500),
        url: apiUrl
      });
      
      ctx.response.status = upstreamResponse.status;
      ctx.response.body = { 
        error: "Upstream API request failed", 
        details: errorBody,
        requestId 
      };
      return;
    }

    logger.info(`Successfully received upstream response, starting stream transformation`, { requestId });
    
    const transformedStream = upstreamResponse.body.pipeThrough(createQwenToOpenAIStreamTransformer());
    
    ctx.response.body = transformedStream;
    ctx.response.headers.set("Content-Type", "text/event-stream");
    ctx.response.headers.set("Cache-Control", "no-cache");
    ctx.response.headers.set("Connection", "keep-alive");
    ctx.response.headers.set("X-Request-Id", requestId);
    
    logger.info(`Stream response started`, { requestId });
  } catch (err: any) {
    logger.error("Error in chat completions proxy", err, { requestId });
    ctx.response.status = 500;
    ctx.response.body = { 
      error: "Internal Server Error", 
      details: err.message,
      requestId 
    };
  }
});

// Health check endpoint
router.get("/health", (ctx: Context) => {
  logger.info("Health check requested");
  ctx.response.body = { 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    version: "3.9",
    config: {
      saltEnabled: !!config.salt,
      serverSideAuth: config.useDenoEnv,
      debugMode: config.debug
    }
  };
});

// Debug test stream endpoint
router.get("/debug/test-stream", (ctx: Context) => {
  ctx.response.headers.set("Content-Type", "text/event-stream");
  ctx.response.headers.set("Cache-Control", "no-cache");
  
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"test": "message1"}\n\n`));
      controller.enqueue(encoder.encode(`data: {"test": "message2"}\n\n`));
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      controller.close();
    }
  });
  
  ctx.response.body = stream;
});

// ============================================================================
// Application Setup and Start
// ============================================================================

app.use(router.routes());
app.use(router.allowedMethods());

// 404 handler
app.use((ctx) => {
  logger.error(`404 Not Found: ${ctx.request.url.pathname}`);
  ctx.response.status = 404;
  ctx.response.body = { 
    error: "Not Found", 
    path: ctx.request.url.pathname,
    timestamp: new Date().toISOString()
  };
});

// Startup logging
console.log("=".repeat(60));
console.log("🚀 Starting Qwen API Proxy Server v3.9...");
console.log("=".repeat(60));

if (config.debug) {
  console.log("🐛 DEBUG MODE ENABLED - Verbose logging active");
}

if (config.useDenoEnv) {
  console.log("🔒 SERVER-SIDE AUTH ENABLED (USE_DENO_ENV=true)");
  if (!config.qwenTokenEnv) {
    console.error("❌ FATAL: USE_DENO_ENV is true, but QWEN_TOKEN environment variable is not set.");
    Deno.exit(1);
  }
  console.log("✅ QWEN_TOKEN loaded from environment.");
  if (config.ssxmodItnaEnv) console.log("🍪 SSXMOD_ITNA_VALUE loaded from environment.");
  if (config.salt) {
    console.log(`🔐 SALT protection enabled: ${config.salt.substring(0,3)}***`);
    console.log("💡 Clients should provide: Authorization: Bearer <SALT_VALUE>");
  } else {
    console.log("💡 No SALT required. Clients can use any Authorization header.");
  }
} else {
  console.log("👤 CLIENT-SIDE AUTH ENABLED (Header-based)");
  if (config.salt) {
    console.log("🔒 SALT PROTECTION ENABLED - Restricted access mode");
    console.log("💡 Clients should provide: Authorization: Bearer salt_value;qwen_token;ssxmod_itna_value");
  } else {
    console.log("🎯 OPEN ACCESS MODE - No salt protection");
    console.log("💡 Clients should provide: Authorization: Bearer qwen_token;ssxmod_itna_value");
  }
}

console.log("=".repeat(60));
console.log("✅ FIXES IN v3.9:");
console.log("  🎯 Prevents duplicate image URLs in stream");
console.log("  • Tracks sent image URLs with Set");
console.log("  • Skips duplicate URLs in image_gen phase");
console.log("  • Only sends unique image URLs once");
console.log("  • Logs image generation phase status");
console.log("=".repeat(60));
console.log("📝 Features:");
console.log("  🎨 Image generation (model-image suffix)");
console.log("  ✏️ Image editing with context awareness");
console.log("  📸 Extracts images from conversation history");
console.log("  🖼️ Supports last 3 images from context");
console.log("  💭 Thinking mode (model-thinking suffix)");
console.log("  🔍 Search mode (model-search suffix)");
console.log("=".repeat(60));

// Start the server
Deno.serve((req) => app.handle(req));

console.log("✅ Server is ready to accept connections.");
console.log("📊 Visit the root URL for API documentation.");
console.log("💡 Set DEBUG=true environment variable for verbose logging.");
console.log("=".repeat(60));

logger.info("Server initialization complete");