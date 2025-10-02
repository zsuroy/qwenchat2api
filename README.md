# Qwen API to OpenAI Standard Proxy

This project provides a lightweight, single-file proxy server designed to run on Deno. It translates standard OpenAI API requests into the proprietary format used by `chat.qwen.ai` and transforms the responses back into the standard OpenAI format.

This allows you to use OpenAI-compatible clients with the Qwen (Tongyi Qianwen) chat service.

## ✨ Features

*   **OpenAI Compatibility:** Acts as a drop-in replacement for the OpenAI API base URL.
*   **Request Conversion:** Translates OpenAI chat completion requests to the Qwen format.
*   **Stream Transformation:** Converts Qwen's Server-Sent Events (SSE) stream to the OpenAI format in real-time.
*   **Model Variants:** Automatically creates special model variants like `qwen-max-thinking` and `qwen-max-search` based on the upstream model capabilities.
*   **Token Rotation:** Supports multiple upstream `API_KEY`s and rotates through them for each request.
*   **Authentication:** Secure your proxy endpoint with an `OPENAI_API_KEY`.
*   **Zero Dependencies (Deno):** Runs as a single script on Deno Deploy or locally without needing `npm install`.

## 🚀 Deployment (Deno Deploy)

1.  **Create a Deno Deploy Project**:
    *   Go to [Deno Deploy](https://deno.com/deploy) and create a new "Playground" project.
    *   Copy the entire content of `main.ts` and paste it into the editor.

2.  **Set Environment Variables**:
    In your Deno Deploy project's "Settings" > "Environment Variables" section, add the following:

    *   `QWEN_TOKEN`: Your Qwen account token(s) for server-side authentication mode. You can provide multiple tokens separated by commas for rotation. (e.g., `ey...abc,ey...def`)
    *   `SSXMOD_ITNA_VALUE`: The special cookie value required for the upstream API in server-side authentication mode.
    *   `USE_DENO_ENV`: (Optional) Set to `true` to enable server-side authentication mode. Default is `false` (client-side authentication).
    *   `SALT`: (Optional) A secret value to restrict access to your proxy. Used for additional security in server-side mode or for restricted access in client-side mode.
    *   `DEBUG`: (Optional) Set to `true` to enable verbose logging. Default is `false`.
    
    Note: For client-side authentication mode (default), credentials are provided in the Authorization header rather than environment variables.

3.  **Run**:
    The script will be deployed and run automatically. Your endpoint URL will be provided by Deno Deploy.

## 🐳 Docker Deployment (简单指南)

### 方法一：使用 Docker Compose（推荐）

1. **创建 .env 文件**：
   ```sh
   # 复制模板
   cp .env.example .env  # 如果有 .env.example 的话
   # 或者直接创建
   touch .env
   ```

2. **编辑 .env 文件，添加以下内容**：
   ```sh
   # 认证模式（默认客户端认证）
   USE_DENO_ENV=false
   
   # 如果使用服务器端认证，取消下面的注释并填入你的值
   # USE_DENO_ENV=true
   # QWEN_TOKEN=你的qwen令牌
   # SSXMOD_ITNA_VALUE=你的cookie值
   
   # 可选设置
   SALT=你的密码值  # 用于限制访问，可选
   DEBUG=false  # 设为 true 开启详细日志
   ```

3. **启动服务**：
   ```sh
   docker-compose up -d --build
   ```

4. **查看日志**：
   ```sh
   docker-compose logs -f
   ```

5. **访问服务**：
   打开浏览器访问 `http://localhost:8000`

### 方法二：直接使用 Docker 命令

1. **构建镜像**：
    ```sh
    docker build -t qwen-proxy .
    ```

2. **运行容器**：
   ```sh
   # 客户端认证模式
   docker run -d -p 8000:8000 --name qwen-proxy \
     -e USE_DENO_ENV=false \
     -e SALT=你的密码值 \
     -e DEBUG=false \
     qwen-proxy
   ```

## 💻 Local Usage

1.  **Save the file** as `main.ts`.

2.  **Set environment variables** in your terminal:
    
    For client-side authentication mode (default):
    ```sh
    # Optional variables
    export USE_DENO_ENV="false"  # This is the default, can be omitted
    export SALT="your_salt_value"  # Optional, for restricted access
    export DEBUG="false"  # Set to "true" for verbose logging
    ```
    In client-side mode, Qwen credentials are provided in the Authorization header with each request.
    
    For server-side authentication mode:
    ```sh
    export USE_DENO_ENV="true"
    export QWEN_TOKEN="your_qwen_token"  # Required for server-side mode
    export SSXMOD_ITNA_VALUE="your_cookie_value"  # Required for server-side mode
    export SALT="your_salt_value"  # Optional, for additional security
    export DEBUG="false"  # Set to "true" for verbose logging
    ```

3.  **Run the script**:
    ```sh
    deno run --allow-net --allow-env main.ts
    ```
    The server will start on `http://localhost:8000`.

## ⚙️ Configuration

The server is configured via the following environment variables:

| Variable               | Description                                                                                             | Required | Example                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------- |
| `QWEN_TOKEN`           | Your Qwen account token(s) for the upstream API. Separate multiple keys with a comma for rotation. Used when `USE_DENO_ENV` is `true`. | **Yes** (when `USE_DENO_ENV` is `true`) | `ey...abc,ey...def`                   |
| `SSXMOD_ITNA_VALUE`    | The required `ssxmod_itna` cookie value from `chat.qwen.ai`. Used when `USE_DENO_ENV` is `true`. | **Yes** (when `USE_DENO_ENV` is `true`) | `mqUxRDBD...DYAEDBYD74G+DDeDixGm...` |
| `USE_DENO_ENV`         | Set to `true` to enable server-side authentication mode. Set to `false` for client-side authentication mode. | No       | `true` or `false` (default: `false`) |
| `SALT`                 | A secret value to restrict access to your proxy. In client-side mode, this is used for restricted access. In server-side mode, this is optional but recommended for additional security. | No (but recommended) | `your_secret_salt_value`              |
| `DEBUG`                | Set to `true` to enable verbose logging for debugging purposes. | No       | `true` or `false` (default: `false`) |

**Note**: In client-side authentication mode (default), `API_KEY` and `SSXMOD_ITNA` are not environment variables but are instead provided in the Authorization header with each request.

### Authentication Modes

The proxy supports two authentication modes:

#### Client-Side Authentication Mode (Default)
When `USE_DENO_ENV` is not set or is `false`:

- Clients provide all required credentials in the Authorization header with each request
- Format: `Authorization: Bearer salt;qwen_token;ssxmod_itna` (if SALT is set)
- Format: `Authorization: Bearer qwen_token;ssxmod_itna` (if SALT is not set)
- Environment variables used: `SALT` (optional), `DEBUG` (optional)
- Note: `qwen_token` and `ssxmod_itna` are provided in the Authorization header, not as environment variables

#### Server-Side Authentication Mode
When `USE_DENO_ENV` is set to `true`:

- Server reads Qwen credentials from environment variables
- Clients only need to provide the SALT value (if set) in the Authorization header
- Format: `Authorization: Bearer salt_value` (if SALT is set)
- Any Authorization header works (if SALT is not set)
- Environment variables used: `QWEN_TOKEN` (required), `SSXMOD_ITNA_VALUE` (required), `SALT` (optional), `DEBUG` (optional)

## 🔌 API Endpoints

*   `GET /v1/models`
    *   Retrieves a list of available Qwen models, including special variants like `-thinking`, `-search`, and `-image`.
*   `POST /v1/chat/completions`
    *   The main endpoint for chat. It accepts standard OpenAI chat completion requests and supports streaming responses.
