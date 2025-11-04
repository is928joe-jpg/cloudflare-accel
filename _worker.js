// ============================================================
// ✅ 用户配置区域
// ============================================================

// 允许访问的注册中心与仓库域名（白名单）
const ALLOWED_HOSTS = [
  'quay.io',
  'gcr.io',
  'k8s.gcr.io',
  'registry.k8s.io',
  'ghcr.io',
  'docker.cloudsmith.io',
  'registry-1.docker.io',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com'
];

// 是否启用路径访问限制（仅在设置为 true 时启用 ALLOWED_PATHS）
const RESTRICT_PATHS = false;

// 路径白名单，仅在 RESTRICT_PATHS = true 时生效
const ALLOWED_PATHS = ['library', 'user-id-1', 'user-id-2'];


// ============================================================
// ✅ REPO_TOKENS 配置说明（从 CF 环境变量读取）
// ============================================================
// 你可以在 Cloudflare Worker 面板或 wrangler.toml 中设置：
//
// [vars]
// REPO_TOKENS = '[{"url":"ghcr.io/user/private-repo","url_token":"token1","repo_token":"ghp_xxx"},{"url":"docker.cloudsmith.io/myuser/private-image","url_token":"token2","repo_token":"cs_yyy"}]'
//
// 前端使用示例：
// https://your-worker.workers.dev/https://ghcr.io/user/private-repo@token1:latest
//
// Worker 内部自动将 “token1” 替换为真实的 “repo_token”，用户永远不会看到真实凭证。
// ============================================================


// ============================================================
// ✅ 从环境变量解析 REPO_TOKENS 配置
// ============================================================
function getRepoTokensFromEnv(env) {
  try {
    if (env.REPO_TOKENS) {
      return JSON.parse(env.REPO_TOKENS);
    }
  } catch (e) {
    console.error('Failed to parse REPO_TOKENS from env:', e);
  }
  return [];
}


// ============================================================
// ✅ 获取最终有效 Token（repo_token / url_token / 匿名）
// ============================================================
// 逻辑说明：
// 1️⃣ 优先匹配 CF 环境变量 REPO_TOKENS 中的配置。
// 2️⃣ 若未找到匹配，则使用 URL 中的 token（@token 或 ?token=xxx）。
// 3️⃣ 若 URL 中未包含 token，则匿名访问（无 Authorization）。
// ============================================================
function getEffectiveToken(targetUrl, env) {
  const REPO_TOKENS = getRepoTokensFromEnv(env);

  // 匹配配置中定义的 url_token
  const tokenEntry = REPO_TOKENS.find(entry =>
    targetUrl.startsWith(entry.url) &&
    entry.url_token &&
    targetUrl.includes(entry.url_token)
  );

  if (tokenEntry) return tokenEntry.repo_token;

  // 尝试从 URL 中提取 token
  try {
    const urlObj = new URL(targetUrl);
    let urlToken = null;

    // 匹配 @token 格式
    const atTokenMatch = urlObj.pathname.match(/@([^@:]+)(:|$)/);
    if (atTokenMatch) urlToken = atTokenMatch[1];

    // 匹配 ?token=xxx 参数
    if (!urlToken && urlObj.searchParams.has('token')) {
      urlToken = urlObj.searchParams.get('token');
    }

    return urlToken || null;
  } catch {
    return null;
  }
}


// ============================================================
// ✅ Docker / GitHub Registry Token 获取
// ============================================================
async function handleToken(realm, service, scope) {
  const tokenUrl = `${realm}?service=${service}&scope=${scope}`;
  try {
    const tokenResponse = await fetch(tokenUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (!tokenResponse.ok) return null;
    const tokenData = await tokenResponse.json();
    return tokenData.token || tokenData.access_token || null;
  } catch {
    return null;
  }
}


// ============================================================
// ✅ 辅助函数：S3 请求识别与签名支持
// ============================================================

// 判断 URL 是否为 Amazon S3
function isAmazonS3(url) {
  try {
    return new URL(url).hostname.includes('amazonaws.com');
  } catch {
    return false;
  }
}

// 返回空请求体的 SHA256 值（S3 必需）
function getEmptyBodySHA256() {
  return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
}


// ============================================================
// ✅ Worker 主逻辑
// ============================================================
// 负责：
// - 解析路径与目标 registry
// - 进行域名/路径校验
// - 处理 token 注入
// - 支持 Docker v2 API / S3 / GitHub
// - 自动处理重定向与鉴权
// ============================================================
async function handleRequest(request, redirectCount = 0, env) {
  const MAX_REDIRECTS = 5;
  const url = new URL(request.url);
  let path = url.pathname;

  // ---- 首页返回 HTML ----
  if (path === '/' || path === '') {
    return new Response(HOMEPAGE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // ---- 判断是否为 Docker v2 请求 ----
  let isV2Request = false;
  let v2RequestType = null;
  let v2RequestTag = null;
  if (path.startsWith('/v2/')) {
    isV2Request = true;
    path = path.replace('/v2/', '');
    const pathSegments = path.split('/').filter(p => p);
    if (pathSegments.length >= 3) {
      v2RequestType = pathSegments[pathSegments.length - 2];
      v2RequestTag = pathSegments[pathSegments.length - 1];
      path = pathSegments.slice(0, pathSegments.length - 2).join('/');
    }
  }

  // ---- 路径解析 ----
  const pathParts = path.split('/').filter(p => p);
  if (pathParts.length < 1)
    return new Response('Invalid request\n', { status: 400 });

  let targetDomain, targetPath, isDockerRequest = false;
  const fullPath = path.startsWith('/') ? path.substring(1) : path;

  // 支持多种输入格式：完整 URL / docker.io / ghcr.io 等
  if (fullPath.startsWith('https://') || fullPath.startsWith('http://')) {
    const urlObj = new URL(fullPath);
    targetDomain = urlObj.hostname;
    targetPath = urlObj.pathname.substring(1) + urlObj.search;
    isDockerRequest = ['quay.io','gcr.io','k8s.gcr.io','registry.k8s.io','ghcr.io','docker.cloudsmith.io','registry-1.docker.io','docker.io'].includes(targetDomain);
    if (targetDomain === 'docker.io') targetDomain = 'registry-1.docker.io';
  } else {
    if (pathParts[0] === 'docker.io') {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.length === 2 ? `library/${pathParts[1]}` : pathParts.slice(1).join('/');
    } else if (ALLOWED_HOSTS.includes(pathParts[0])) {
      targetDomain = pathParts[0];
      targetPath = pathParts.slice(1).join('/') + url.search;
      isDockerRequest = ['quay.io','gcr.io','k8s.gcr.io','registry.k8s.io','ghcr.io','docker.cloudsmith.io','registry-1.docker.io'].includes(targetDomain);
    } else if (pathParts.length >= 1 && pathParts[0] === 'library') {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.join('/');
    } else if (pathParts.length >= 2) {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.join('/');
    } else {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = `library/${pathParts.join('/')}`;
    }
  }

  // ---- 域名与路径校验 ----
  if (!ALLOWED_HOSTS.includes(targetDomain))
    return new Response(`Error: Invalid target domain.\n`, { status: 400 });

  if (RESTRICT_PATHS) {
    const checkPath = isDockerRequest ? targetPath : path;
    const isPathAllowed = ALLOWED_PATHS.some(p =>
      checkPath.toLowerCase().includes(p.toLowerCase())
    );
    if (!isPathAllowed)
      return new Response(`Error: Path not allowed\n`, { status: 403 });
  }

  // ---- 构建目标 URL ----
  let targetUrl = isDockerRequest
    ? (isV2Request && v2RequestType && v2RequestTag
        ? `https://${targetDomain}/v2/${targetPath}/${v2RequestType}/${v2RequestTag}`
        : `https://${targetDomain}/${isV2Request ? 'v2/' : ''}${targetPath}`)
    : `https://${targetDomain}/${targetPath}`;

  // ---- 请求头处理 ----
  const newRequestHeaders = new Headers(request.headers);
  newRequestHeaders.set('Host', targetDomain);
  newRequestHeaders.delete('x-amz-content-sha256');
  newRequestHeaders.delete('x-amz-date');
  newRequestHeaders.delete('x-amz-security-token');
  newRequestHeaders.delete('x-amz-user-agent');

  // ---- 注入 Authorization Token ----
  const effectiveToken = getEffectiveToken(targetUrl, env);
  if (effectiveToken)
    newRequestHeaders.set('Authorization', `Bearer ${effectiveToken}`);
  else
    newRequestHeaders.delete('Authorization');

  // ---- Amazon S3 请求头修正 ----
  if (isAmazonS3(targetUrl)) {
    newRequestHeaders.set('x-amz-content-sha256', getEmptyBodySHA256());
    newRequestHeaders.set('x-amz-date', new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5)+'Z');
  }

  // ---- 发送请求与响应处理 ----
  try {
    let response = await fetch(targetUrl, {
      method: request.method,
      headers: newRequestHeaders,
      body: request.body,
      redirect: 'manual'
    });

    // Docker 401 授权处理
    if (isDockerRequest && response.status === 401) {
      const wwwAuth = response.headers.get('WWW-Authenticate');
      if (wwwAuth) {
        const authMatch = wwwAuth.match(/Bearer realm="([^"]+)",service="([^"]*)",scope="([^"]*)"/);
        if (authMatch) {
          const [, realm, service, scope] = authMatch;
          const token = await handleToken(realm, service || targetDomain, scope);
          if (token) {
            const authHeaders = new Headers(request.headers);
            authHeaders.set('Authorization', `Bearer ${token}`);
            authHeaders.set('Host', targetDomain);
            if (isAmazonS3(targetUrl)) {
              authHeaders.set('x-amz-content-sha256', getEmptyBodySHA256());
              authHeaders.set('x-amz-date', new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5)+'Z');
            }
            response = await fetch(new Request(targetUrl, { method: request.method, headers: authHeaders, body: request.body, redirect: 'manual' }));
          }
        }
      }
    }

    // Docker / S3 重定向处理
    if (isDockerRequest && (response.status === 302 || response.status === 307)) {
      const redirectUrl = response.headers.get('Location');
      if (redirectUrl) {
        const redirectHeaders = new Headers(request.headers);
        redirectHeaders.set('Host', new URL(redirectUrl).hostname);
        if (isAmazonS3(redirectUrl)) {
          redirectHeaders.set('x-amz-content-sha256', getEmptyBodySHA256());
          redirectHeaders.set('x-amz-date', new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5)+'Z');
        }
        if (response.headers.get('Authorization')) {
          redirectHeaders.set('Authorization', response.headers.get('Authorization'));
        }
        response = await fetch(new Request(redirectUrl, { method: request.method, headers: redirectHeaders, body: request.body, redirect: 'manual' }));
      }
    }

    // ---- 构建最终响应 ----
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin','*');
    newResponse.headers.set('Access-Control-Allow-Methods','GET, HEAD, POST, OPTIONS');
    if (isDockerRequest) {
      newResponse.headers.set('Docker-Distribution-API-Version','registry/2.0');
      newResponse.headers.delete('Location');
    }

    return newResponse;
  } catch (e) {
    return new Response(`Error fetching from ${targetDomain}: ${e.message}\n`, { status: 500 });
  }
}


// ============================================================
// ✅ Worker 导出（Cloudflare 标准结构）
// ============================================================
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, 0, env);
  }
};
