// ✅ 소셜 로그인(구글/카카오): Provider별 인가 URL 생성, 토큰 교환, 프로필 조회
//
// 콜백 라우트가 실패 원인을 구분해서 앱에 내려줄 수 있도록,
// 이 모듈은 실패 시 항상 OAuthProviderError(code)를 던진다.
// code는 config/errors.js의 ERRORS 값과 1:1로 맞춘다 (ACCESS_DENIED / PROVIDER_ERROR).

const { ERRORS } = require('../../config/errors');

class OAuthProviderError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const PROVIDER_CONFIG = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scope: 'openid email profile',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: () => process.env.GOOGLE_REDIRECT_URI,
  },
  kakao: {
    authUrl: 'https://kauth.kakao.com/oauth/authorize',
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    profileUrl: 'https://kapi.kakao.com/v2/user/me',
    scope: 'account_email profile_nickname',
    clientId: () => process.env.KAKAO_CLIENT_ID,
    clientSecret: () => process.env.KAKAO_CLIENT_SECRET, // 카카오는 선택 사항(콘솔 설정에 따라 다름)
    redirectUri: () => process.env.KAKAO_REDIRECT_URI,
  },
};

function getProviderConfig(provider) {
  const config = PROVIDER_CONFIG[provider];
  if (!config) throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, `UNKNOWN_PROVIDER:${provider}`);
  // client_id/redirect_uri 없이 진행하면 Provider에 빈 값으로 요청을 보내게 되어
  // 실패 원인을 알 수 없는 채로 사용자에게만 에러가 노출된다 — 여기서 먼저 명확히 막는다.
  if (!config.clientId() || !config.redirectUri()) {
    throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, `OAUTH_ENV_MISSING:${provider}`);
  }
  return config;
}

// Provider 인가 화면 URL 생성 (state는 호출부에서 발급/저장)
function getAuthorizationUrl(provider, state) {
  const config = getProviderConfig(provider);
  const params = new URLSearchParams({
    client_id: config.clientId() || '',
    redirect_uri: config.redirectUri() || '',
    response_type: 'code',
    scope: config.scope,
    state,
  });
  return `${config.authUrl}?${params.toString()}`;
}

// Provider 인가 코드를 access token으로 교환
async function exchangeCodeForToken(provider, code) {
  const config = getProviderConfig(provider);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId() || '',
    redirect_uri: config.redirectUri() || '',
    code,
  });
  const clientSecret = config.clientSecret();
  if (clientSecret) body.set('client_secret', clientSecret);

  let res;
  try {
    res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, 'TOKEN_REQUEST_FAILED');
  }

  if (!res.ok) {
    throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, `TOKEN_EXCHANGE_FAILED:${res.status}`);
  }

  const data = await res.json();
  if (!data?.access_token) {
    throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, 'TOKEN_MISSING_IN_RESPONSE');
  }
  return data.access_token;
}

// access token으로 Provider 프로필 조회, { providerId, email, name } 형태로 정규화
async function fetchProfile(provider, accessToken) {
  const config = getProviderConfig(provider);

  let res;
  try {
    res = await fetch(config.profileUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, 'PROFILE_REQUEST_FAILED');
  }

  if (!res.ok) {
    throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, `PROFILE_FETCH_FAILED:${res.status}`);
  }

  const data = await res.json();

  if (provider === 'google') {
    if (!data?.sub) throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, 'PROFILE_MISSING_SUB');
    return {
      providerId: data.sub,
      email: data.email || null,
      name: data.name || null,
    };
  }

  if (provider === 'kakao') {
    if (!data?.id) throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, 'PROFILE_MISSING_ID');
    return {
      providerId: String(data.id),
      email: data.kakao_account?.email || null,
      name: data.kakao_account?.profile?.nickname || null,
    };
  }

  throw new OAuthProviderError(ERRORS.PROVIDER_ERROR, `UNKNOWN_PROVIDER:${provider}`);
}

module.exports = {
  OAuthProviderError,
  getAuthorizationUrl,
  exchangeCodeForToken,
  fetchProfile,
};
