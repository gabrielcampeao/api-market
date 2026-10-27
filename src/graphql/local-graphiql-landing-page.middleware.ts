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
// The landing page itself is the same UI @nestjs/apollo's built-in
// `graphiql: true` renders, but pointing at assets vendored under
// public/graphiql-vendor/ instead of unpkg.com — dev tooling shouldn't
// depend on an external CDN being reachable (corporate firewalls, ad
// blockers, and offline dev all break it silently: the page loads with
// zero styling and no visible error).
const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>GraphiQL</title>
    <style>
      body { height: 100%; margin: 0; width: 100%; overflow: hidden; }
      #graphiql { height: 100vh; }
    </style>
    <script src="/graphiql-assets/react.development.js"></script>
    <script src="/graphiql-assets/react-dom.development.js"></script>
    <link rel="stylesheet" href="/graphiql-assets/graphiql.min.css" />
  </head>
  <body>
    <div id="graphiql">Loading...</div>
    <script src="/graphiql-assets/graphiql.min.js" type="application/javascript"></script>
    <script>
      const fetcher = GraphiQL.createFetcher({ url: '/graphql', subscriptionUrl: '/graphql' });
      ReactDOM.render(
        React.createElement(GraphiQL, {
          fetcher,
          defaultEditorToolsVisibility: true,
          shouldPersistHeaders: true,
          isHeadersEditorEnabled: true,
          inputValueDeprecation: false,
        }),
        document.getElementById('graphiql'),
      );
    </script>
  </body>
</html>`;

export function localGraphiqlLandingPage(): RequestHandler {
  return (req: Request, res: Response, next: () => void) => {
    if (req.method === 'GET' && req.accepts('html')) {
      res.type('html').send(HTML);
      return;
    }
    next();
  };
}
