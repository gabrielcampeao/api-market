import { Request, RequestHandler, Response } from 'express';
const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Apollo Server</title>
    <style>
      body { height: 100%; margin: 0; width: 100%; overflow: hidden; }
      iframe { background-color: white; height: 100%; width: 100%; border: none; }
      #embeddableSandbox { width: 100vw; height: 100vh; position: absolute; top: 0; }
    </style>
  </head>
  <body>
    <div id="embeddableSandbox"></div>
    <script src="https://embeddable-sandbox.cdn.apollographql.com/_latest/embeddable-sandbox.umd.production.min.js"></script>
    <script>
      new window.EmbeddedSandbox({
        target: '#embeddableSandbox',
        initialEndpoint: window.location.href,
        endpointIsEditable: false,
        runTelemetry: false,
      });
    </script>
  </body>
</html>`;
export function apolloSandboxLandingPage(): RequestHandler {
  return (req: Request, res: Response, next: () => void) => {
    if (req.method === 'GET' && req.accepts('html')) {
      res.type('html').send(HTML);
      return;
    }
    next();
  };
}
