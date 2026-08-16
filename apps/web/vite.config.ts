import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, '.', '')
  if (command === 'build' && environment.NODE_ENV !== 'development') {
    const sourceUrl = environment.VITE_SOURCE_URL?.trim()
    try {
      const parsed = new URL(sourceUrl ?? '')
      const isHttp = parsed.protocol === 'https:' || parsed.protocol === 'http:'
      if (!isHttp || parsed.username || parsed.password) throw new Error()
    } catch {
      throw new Error('VITE_SOURCE_URL must be an absolute HTTP(S) URL for production builds.')
    }
  }

  return {
    plugins: [react()],
    build: {
      // Vite 8 bundles with Rolldown. `build.rollupOptions` is a deprecated alias
      // and `output.manualChunks` is on its way out, so grouping is expressed with
      // Rolldown's `codeSplitting` instead.
      //
      // Rolldown already splits the lazily-imported routes on its own. What it
      // does not do here is separate third-party code, because it only creates a
      // shared chunk for modules imported by two or more entries and this app has
      // one entry. Measured without this group, React collapses into the entry
      // chunk: 345 kB / 100 kB gzip in one file. Total bytes are the same either
      // way — what changes is cache granularity. Third-party code turns over far
      // less often than application code, so keeping it separate means a release
      // invalidates ~21 kB gzip instead of ~100 kB, and returning visitors reuse
      // the cached vendor chunk. Paired with the immutable Cache-Control on
      // /assets/* in apps/web/public/_headers, that is the difference between a
      // repeat visit fetching nothing and refetching everything.
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [{ test: /node_modules[\\/]/, name: 'vendor', priority: 0 }],
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
          fetchOptions: {
            onBeforeRequest(requestOptions) {
              const headers = new Headers(requestOptions.headers)
              const origin = headers.get('origin')
              if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173') {
                headers.set('origin', 'http://127.0.0.1:8787')
              }
              requestOptions.headers = headers
            },
          },
          configure(proxy) {
            const eventProxy = proxy as unknown as {
              on(event: 'proxyRes', listener: (response: { headers: Record<string, string | string[] | undefined> }) => void): void
            }
            eventProxy.on('proxyRes', (response) => {
              // Vite has already decoded the local Worker's body before forwarding it.
              delete response.headers['content-encoding']
              delete response.headers['content-length']
            })
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      css: true,
    },
  }
})
