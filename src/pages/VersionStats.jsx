import { useEffect, useState } from 'react'

const API_URL = 'https://xlba-eg1u-i4nx.n7e.xano.io/api:-GTDJqKH/version_stats'

export default function VersionStats() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(API_URL)
      .then(r => r.json())
      .then(json => { setData(json); setLoading(false) })
      .catch(() => { setError('Failed to load stats.'); setLoading(false) })
  }, [])

  return (
    <div style={{ fontFamily: 'monospace', padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <p style={{ fontSize: '0.8rem', color: '#888', marginBottom: '2rem' }}>
        March 31, 2026 to {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
      </p>

      {loading && <p>Loading...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {data && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #333', textAlign: 'left' }}>
              <th style={{ paddingBottom: '0.5rem' }}>Version</th>
              <th style={{ paddingBottom: '0.5rem' }}>Total</th>
              <th style={{ paddingBottom: '0.5rem' }}>iOS</th>
              <th style={{ paddingBottom: '0.5rem' }}>Android</th>
            </tr>
          </thead>
          <tbody>
            {data.versions?.map(v => (
              <tr key={v.app_version} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem 0' }}>{v.app_version}</td>
                <td style={{ padding: '0.5rem 0' }}>{v.count}</td>
                <td style={{ padding: '0.5rem 0' }}>{v.ios}</td>
                <td style={{ padding: '0.5rem 0' }}>{v.android}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ fontSize: '0.7rem', color: '#aaa', marginTop: '2rem' }}>
        {new Date().toLocaleString()}
      </p>
    </div>
  )
}
