import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

/**
 * GET /api/docs
 *
 * Renders a Swagger UI page that loads /api/openapi.json. The Swagger UI
 * assets are loaded from the official CDN (unpkg.com) so we don't have to
 * bundle them. No authentication required to view the docs (the spec itself
 * documents which routes need auth).
 */

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Onyx Base · API Docs</title>
    <link rel="icon" href="/icon.png" />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui.css" />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
      #topbar { background: #1a1a1a; color: #f5f5f5; padding: 10px 18px; display: flex; align-items: center; gap: 10px; }
      #topbar a { color: #fbbf24; text-decoration: none; font-weight: 600; }
      #topbar .muted { color: #888; font-size: 13px; }
      #swagger-ui { max-width: 1280px; margin: 0 auto; background: #fff; min-height: calc(100vh - 50px); box-shadow: 0 0 24px rgba(0,0,0,0.06); }
    </style>
  </head>
  <body>
    <div id="topbar">
      <span style="font-size:18px;font-weight:700;">Onyx Base</span>
      <span class="muted">· API documentation (OpenAPI 3.0)</span>
      <span style="flex:1"></span>
      <a href="/api/openapi.json" target="_blank" rel="noopener">View raw JSON</a>
    </div>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: '/api/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          docExpansion: 'list',
          defaultModelsExpandDepth: 1,
          persistAuthorization: true,
          presets: [SwaggerUIBundle.presets.apis],
        });
      };
    </script>
  </body>
</html>`

export async function GET() {
  return new NextResponse(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
