export function resourceMetadata(authority) {
  return { resource: authority.audience('mcp'), authorization_servers: [authority.issuer()],
    scopes_supported: ['boards:read', 'boards:collaborate'], bearer_methods_supported: ['header'],
    resource_name: 'Plexiform selected boards' };
}
export function authorizationMetadata(authority) {
  const issuer = authority.issuer();
  return { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    authorization_response_iss_parameter_supported: true,
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['boards:read', 'boards:collaborate'] };
}
export function challenge(authority, scope = null) {
  return `Bearer resource_metadata="${authority.issuer()}/.well-known/oauth-protected-resource/api/mcp"`
    + (scope ? ', error="insufficient_scope", scope="boards:read boards:collaborate"' : '');
}
