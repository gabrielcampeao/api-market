import { Request, RequestHandler, Response } from 'express';

// @nestjs/apollo always injects its own landing-page plugin (graphiql,
// playground, or disabled) into the Apollo Server it builds, and Apollo
// Server hard-errors ("Only one plugin can implement renderLandingPage")
// if a second plugin also implements it — there's no supported way to swap
// in a custom Apollo plugin here. Intercepting the route at the Express
// layer instead sidesteps that entirely: main.ts registers this before
// app.listen() calls GraphQLModule.onModuleInit(), which is what actually
// mounts Apollo's own /graphql middleware, so this always runs first.
//
// This renders the same Apollo Sandbox UI `ApolloServerPluginLandingPageLocalDefault`
// would (see @apollo/server/dist/cjs/plugin/landingPage/default/getEmbeddedHTML.js,
// which this is adapted from) without importing that plugin directly — its
// subpath import triggers a dual cjs/esm type-resolution conflict under
// ts-jest that broke the e2e suite's typecheck. Unlike GraphiQL, Sandbox
// can't be fully self-hosted: the UI itself renders inside an iframe served
// live from Apollo's own CDN (embeddable-sandbox.cdn.apollographql.com), so
// it still depends on that domain being reachable — runTelemetry is turned
// off, but the CDN dependency itself is inherent to how Sandbox works.
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
