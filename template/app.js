import fs from 'fs'
import http from 'http'
import path from 'path'
import LRU from 'lru-cache'
import express from 'express'
import session from './handler/session'
import routes from './handler/routes'
import handleSock from './handler/socket'
import config from './handler/config'
import raven from './handler/raven'

var resolve = file => path.resolve(__dirname, file),
   redirects = require('./router/301.json'),
   isProd = process.env.NODE_ENV === 'production',
   useMicroCache = process.env.MICRO_CACHE !== 'false',
   serverInfo = `Driffle-Server Powered with Server-Side-Rendering`

var app = express(),
   server = http.createServer(app),
   socketIO = require('socket.io'),
   io = socketIO(server),
   params = require('./handler/params')

// render functions for Vue 2 SSR
var createRenderer = require('./handler/createRender')

let renderer, readyPromise;

if (isProd) {
  const bundle = require('./public/vue-ssr-server-bundle.json')
  const clientManifest = require('./public/vue-ssr-client-manifest.json')
  renderer = createRenderer(bundle, {
    clientManifest
  })
} else {
  readyPromise = require('./build/setup-dev-server')(app, (bundle, options) => {
    renderer = createRenderer(bundle, options)
  })
}
// master Error Handling with SENTRY THE LEGEND
raven(app, config.sentry.dsn)

// 301 redirect for changed routes
Object.keys(redirects).forEach(k => {
  app.get(k, (req, res) => res.redirect(301, redirects[k]))
})

// https://www.nginx.com/blog/benefits-of-microcaching-nginx/
const microCache = LRU({
  max: 100,
  maxAge: 1000
})
const isCacheable = req => useMicroCache

let nonVueRoutes = []

for(let i in routes.stack) {
  nonVueRoutes.push(routes.stack[i]["route"]["path"].toLowerCase())
}

let render = (req, res) => {
  if(nonVueRoutes.indexOf(req.url.split("?")[0].toLowerCase()) === -1) {
      const s = Date.now()
      
      res.setHeader("Content-Type", "text/html")
      res.removeHeader('X-Powered-By');
    
      const handleError = err => {
        if (err && err.code === 404) {
          res.status(404).end('404 | Page Not Found')
        } else {
          // Render Error Page or Redirect
          res.status(500).end('500 | Internal Server Error')
          console.error(`error during render : ${req.url}`)
          console.error(err.stack)
        }
      }
    
      const cacheable = isCacheable(req)
      if (cacheable) {
        const hit = microCache.get(req.url)
        if (hit) {
          if (!isProd) {
            console.log(`cache hit!`)
          }
          return res.end(hit)
        }
      }
    
      const context = {
        title: 'Driffle - Read, Write, Create Content with Fun.', // default title
        url: req.url
      }
      renderer.renderToString(context, (err, html) => {
        if (err) {
          return handleError(err)
        }
        res.end(html)
        if (cacheable) {
          microCache.set(req.url, html)
        }
        if (!isProd) {
          console.log(`whole request: ${Date.now() - s}ms`)
        }
      })
  } else {
    // don't do shit.
  }
}
// handle app.use functions
params(app)

// handle session of the app
session(app, io)

// routes
app.use('/', routes)

// vue route
app.get('*', isProd ? render : (req, res) => {
  readyPromise.then(() => render(req, res))
})
// socket.io
io.on('connection', (socket) => {
  handleSock(socket);
})

module.exports = server;
