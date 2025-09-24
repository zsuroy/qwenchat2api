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

    *   `OPENAI_API_KEY`: (Recommended) Your secret key for clients to access this proxy. (e.g., `sk-my-secret-key-12345`)
    *   `API_KEY`: Your Qwen account token(s). You can provide multiple tokens separated by commas for rotation. (e.g., `ey...abc,ey...def`)
    *   `SSXMOD_ITNA`: The special cookie value required for the upstream API.

3.  **Run**:
    The script will be deployed and run automatically. Your endpoint URL will be provided by Deno Deploy.

## 💻 Local Usage

1.  **Save the file** as `main.ts`.

2.  **Set environment variables** in your terminal:
    ```sh
    export OPENAI_API_KEY="your_secret_proxy_key"
    export API_KEY="your_qwen_token"
    export SSXMOD_ITNA="your_cookie_value"
    ```

3.  **Run the script**:
    ```sh
    deno run --allow-net --allow-env main.ts
    ```
    The server will start on `http://localhost:8000`.

## ⚙️ Configuration

The server is configured via the following environment variables:

| Variable          | Description                                                                                             | Required | Example                               |
| ----------------- | ------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------- |
| `OPENAI_API_KEY`  | A secret Bearer token to protect your proxy endpoint. If not set, the proxy will be open to the public. | No       | `sk-my-secret-key-12345`              |
| `API_KEY`         | Your Qwen account token(s) for the upstream API. Separate multiple keys with a comma for rotation.      | **Yes**  | `ey...abc,ey...def`                   |
| `SSXMOD_ITNA`     | The required `ssxmod_itna` cookie value from `chat.qwen.ai`.                                            | Yes      | `mqUxRDBD...DYAEDBYD74G+DDeDixGm...` |

## 🔌 API Endpoints

*   `GET /v1/models`
    *   Retrieves a list of available Qwen models, including special variants like `-thinking`, `-search`, and `-image`.
*   `POST /v1/chat/completions`
    *   The main endpoint for chat. It accepts standard OpenAI chat completion requests and supports streaming responses.
