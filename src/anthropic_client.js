/**
 * AnthropicClient — 统一 AI 客户端（支持 Anthropic / OpenAI 兼容格式）
 *
 * 通过 apiType 参数自动适配两种协议：
 * - 'anthropic': Anthropic Messages API 格式（LongCat 等）
 * - 'openai':   OpenAI Chat Completions 格式（智谱 GLM 常规 API 等）
 *
 * Usage:
 *   // Anthropic 格式
 *   const client = new AnthropicClient({
 *     baseURL: 'https://api.longcat.chat/anthropic/v1',
 *     apiKey: process.env.LONGCAT_API_KEY,
 *     model: 'LongCat-2.0',
 *     apiType: 'anthropic'
 *   });
 *
 *   // OpenAI 格式（智谱常规 API）
 *   const client = new AnthropicClient({
 *     baseURL: 'https://open.bigmodel.cn/api/paas/v4',
 *     apiKey: process.env.ZAI_API_KEY,
 *     model: 'glm-5.1',
 *     apiType: 'openai'
 *   });
 *
 *   // 纯文本请求
 *   const text = await client.complete({
 *     system: 'You are a helpful assistant',
 *     messages: [{ role: 'user', content: 'Hello' }]
 *   });
 *
 *   // 带图片的请求（自动降级为纯文本重试）
 *   const text2 = await client.completeWithFallback({
 *     system: '...',
 *     userText: '分析这个商品',
 *     images: ['https://.../1.jpg']
 *   });
 *
 *   // 直接获取 JSON
 *   const json = await client.completeJSON({
 *     system: '...',
 *     messages: [{ role: 'user', content: '返回JSON' }]
 *   });
 */

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_TIMEOUT_MS = 120000;
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_IMAGES = 3;

class AnthropicClient {
  constructor(options = {}) {
    if (!options.baseURL) throw new Error('AnthropicClient: baseURL 是必需的');
    if (!options.apiKey) throw new Error('AnthropicClient: apiKey 是必需的');
    if (!options.model) throw new Error('AnthropicClient: model 是必需的');

    this.baseURL = String(options.baseURL).replace(/\/$/, '');
    this.apiKey = String(options.apiKey);
    this.model = String(options.model);
    this.maxTokens = Number(options.maxTokens) || DEFAULT_MAX_TOKENS;
    this.temperature = options.temperature !== undefined ? options.temperature : DEFAULT_TEMPERATURE;
    this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.apiVersion = options.apiVersion || ANTHROPIC_VERSION;
    // 'anthropic' | 'openai'，默认 anthropic
    this.apiType = options.apiType === 'openai' ? 'openai' : 'anthropic';
  }

  /**
   * 发起一次对话请求，返回模型输出的文本。
   * @param {Object} params
   * @param {string} [params.system]       - 系统提示词
   * @param {Array}  params.messages       - 消息数组 [{role, content}]
   * @param {number} [params.maxTokens]    - 可选，覆盖默认 max_tokens
   * @param {number} [params.temperature]  - 可选，覆盖默认 temperature
   * @returns {Promise<string>}
   */
  async complete({ system, messages, maxTokens, temperature } = {}) {
    const endpoint = this._buildEndpoint();
    const body = this._buildBody(system, messages, maxTokens, temperature);
    return this._request(endpoint, body);
  }

  /**
   * 发起对话请求并解析返回的 JSON 对象。
   * @returns {Promise<Object>}
   */
  async completeJSON({ system, messages, maxTokens, temperature } = {}) {
    const text = await this.complete({ system, messages, maxTokens, temperature });
    return extractJSON(text);
  }

  /**
   * 便捷方法：纯文本用户消息。
   * @param {string} userText
   * @returns {Promise<string>}
   */
  async completeText({ system, userText, maxTokens, temperature } = {}) {
    return this.complete({
      system,
      messages: [{ role: 'user', content: userText }],
      maxTokens,
      temperature
    });
  }

  /**
   * 便捷方法：带图片的请求，失败时自动降级为纯文本重试。
   * @param {Object} params
   * @param {string} [params.system]
   * @param {string} params.userText
   * @param {Array<string>} [params.images]  - 图片 URL 列表
   * @param {number} [params.maxTokens]
   * @param {number} [params.temperature]
   * @returns {Promise<string>}
   */
  async completeWithFallback({ system, userText, images, maxTokens, temperature } = {}) {
    const validImages = (images || []).filter(Boolean).slice(0, MAX_IMAGES);

    if (validImages.length === 0) {
      return this.completeText({ system, userText, maxTokens, temperature });
    }

    const visionContent = this._buildVisionContent(userText, validImages);

    try {
      return this.complete({
        system,
        messages: [{ role: 'user', content: visionContent }],
        maxTokens,
        temperature
      });
    } catch (error) {
      console.warn(`[AI] 图片请求失败，改用纯文本重试: ${error.message}`);
      return this.completeText({ system, userText, maxTokens, temperature });
    }
  }

  // ==================== 内部方法 ====================

  _buildEndpoint() {
    if (this.apiType === 'openai') {
      return `${this.baseURL}/chat/completions`;
    }
    return `${this.baseURL}/messages`;
  }

  _buildBody(system, messages, maxTokens, temperature) {
    const msgList = Array.isArray(messages) ? messages : [];
    const tokens = Number(maxTokens) || this.maxTokens;
    const temp = temperature !== undefined ? temperature : this.temperature;

    if (this.apiType === 'openai') {
      // OpenAI 格式：system 作为 messages 数组的第一条
      const fullMessages = system
        ? [{ role: 'system', content: system }, ...msgList]
        : msgList;
      return {
        model: this.model,
        messages: fullMessages,
        max_tokens: tokens,
        temperature: temp
      };
    }

    // Anthropic 格式：system 作为顶层字段
    const body = {
      model: this.model,
      messages: msgList,
      max_tokens: tokens,
      temperature: temp
    };
    if (system) body.system = system;
    return body;
  }

  _buildVisionContent(text, images) {
    if (this.apiType === 'openai') {
      // OpenAI vision 格式
      return [
        { type: 'text', text },
        ...images.map((url) => ({
          type: 'image_url',
          image_url: { url }
        }))
      ];
    }
    // Anthropic vision 格式
    return [
      { type: 'text', text },
      ...images.map((url) => ({
        type: 'image',
        source: { type: 'url', url }
      }))
    ];
  }

  async _request(endpoint, body) {
    if (typeof fetch !== 'function') {
      throw new Error('当前 Node.js 没有 fetch，请使用 Node.js 18 或更高版本');
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
    // Anthropic 协议需要版本请求头
    if (this.apiType === 'anthropic') {
      headers['anthropic-version'] = this.apiVersion;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`AI 请求超时 (${this.timeoutMs}ms): ${endpoint}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AI 请求失败 ${response.status}: ${text.slice(0, 500)}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`AI 响应不是合法 JSON: ${text.slice(0, 300)}`);
    }

    return this._parseResponse(json);
  }

  _parseResponse(json) {
    if (this.apiType === 'openai') {
      // OpenAI 格式: choices[0].message.content
      const content = json.choices
        && json.choices[0]
        && json.choices[0].message
        && typeof json.choices[0].message.content === 'string'
        ? json.choices[0].message.content
        : null;
      if (!content) throw new Error(`AI 响应为空: ${JSON.stringify(json).slice(0, 300)}`);
      return content;
    }

    // Anthropic 格式: content[].text
    const blocks = Array.isArray(json.content) ? json.content : [];
    const content = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');

    if (!content) throw new Error(`AI 响应为空: ${JSON.stringify(json).slice(0, 300)}`);
    return content;
  }
}

// 从 AI 文本输出中提取 JSON（剥离 markdown 围栏，取最外层 {...}）
function extractJSON(content) {
  const raw = String(content || '').trim();
  const withoutFence = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch (_) {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1));
    }
    throw new Error(`AI 返回不是可解析 JSON: ${raw.slice(0, 300)}`);
  }
}

module.exports = { AnthropicClient, extractJSON };
