// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import { ENV } from './_core/env';
import FormData from 'form-data';
import axios from 'axios';

// Add request interceptor for debugging
axios.interceptors.request.use(
  (config) => {
    if (config.url?.includes('/storage/')) {
      console.log('[Storage Request]', {
        method: config.method,
        url: config.url,
        hasAuth: !!config.headers?.Authorization,
        authPrefix: config.headers?.Authorization?.toString().substring(0, 20) + '...',
        contentType: config.headers?.['Content-Type'],
      });
    }
    return config;
  },
  (error) => {
    console.error('[Storage Request Error]', error);
    return Promise.reject(error);
  }
);

// Add response interceptor for debugging
axios.interceptors.response.use(
  (response) => {
    if (response.config.url?.includes('/storage/')) {
      console.log('[Storage Response]', {
        status: response.status,
        statusText: response.statusText,
        url: response.config.url,
      });
    }
    return response;
  },
  (error) => {
    if (error.config?.url?.includes('/storage/')) {
      console.error('[Storage Response Error]', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url,
        data: error.response?.data,
      });
    }
    return Promise.reject(error);
  }
);

type StorageConfig = { baseUrl: string; apiKey: string };

function getStorageConfig(): StorageConfig {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function buildUploadUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

async function buildDownloadUrl(
  baseUrl: string,
  relKey: string,
  apiKey: string
): Promise<string> {
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(downloadApiUrl, {
    method: "GET",
    headers: buildAuthHeaders(apiKey),
  });
  return (await response.json()).url;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function toFormData(
  data: Buffer | Uint8Array | string,
  contentType: string,
  fileName: string
): FormData {
  const form = new FormData();
  const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  form.append("file", buffer, {
    filename: fileName || "file",
    contentType: contentType,
  });
  return form;
}

function buildAuthHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
  maxRetries = 3
): Promise<{ key: string; url: string }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const formData = toFormData(data, contentType, key.split("/").pop() ?? key);

  console.log('[Storage] Upload attempt:', {
    url: uploadUrl.toString(),
    key,
    contentType,
    dataSize: Buffer.byteLength(typeof data === 'string' ? data : Buffer.from(data)),
    hasApiKey: !!apiKey,
    apiKeyPrefix: apiKey.substring(0, 10) + '...',
  });

  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(uploadUrl.toString(), formData, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...formData.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000, // 30 second timeout
      });

      const url = response.data.url;
      console.log('[Storage] Upload successful:', { key, url, attempt });
      return { key, url };
    } catch (error: any) {
      lastError = error;
      const status = error.response?.status || 500;
      const statusText = error.response?.statusText || 'Unknown Error';
      const message = error.response?.data ? 
        (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data)) :
        error.message;
      
      console.error(`[Storage] Upload failed (attempt ${attempt}/${maxRetries}):`, {
        status,
        statusText,
        url: uploadUrl.toString(),
        message: message.substring(0, 500),
      });
      
      // Don't retry on client errors (4xx) except 408 (timeout) and 429 (rate limit)
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        break;
      }
      
      // Wait before retrying (exponential backoff)
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`[Storage] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // All retries failed
  const status = lastError.response?.status || 500;
  const statusText = lastError.response?.statusText || 'Unknown Error';
  const message = lastError.response?.data ? 
    (typeof lastError.response.data === 'string' ? lastError.response.data : JSON.stringify(lastError.response.data)) :
    lastError.message;
  
  throw new Error(
    `Storage upload failed after ${maxRetries} attempts (${status} ${statusText}): ${message}`
  );
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string; }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  return {
    key,
    url: await buildDownloadUrl(baseUrl, key, apiKey),
  };
}
