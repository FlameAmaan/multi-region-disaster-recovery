
import { useMemo } from 'react'

function parseReportJson(value) {
  try {
    if (!value) return null
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return null
  }
}

export default function ReliabilityChart({ logs = [] }) {
  const stats = useMemo(() => {
    let ready = 0
    let degraded = 0
    let other = 0

    for (const log of logs) {
      const report = parseReportJson(log.report_json)

      const status = String(
        log.status ?? report?.summary?.overall_status ?? '',
      ).trim().toUpperCase()

      if (status === 'READY') {
        ready += 1
      } else if (status === 'DEGRADED') {
        degraded += 1
      } else {
        other += 1
      }
    }

    const classified = ready + degraded
    const successRate =
      classified > 0 ? (ready / classified) * 100 : null

    return {
      ready,
      degraded,
      other,
      classified,
      total: logs.length,
      successRate,
    }
  }, [logs])

  const readyWidth =
    stats.classified > 0 ? (stats.ready / stats.classified) * 100 : 0

  const degradedWidth =
    stats.classified > 0 ? (stats.degraded / stats.classified) * 100 : 0

  return (
    <section className="placeholder-panel">
      <div className="section-heading">
        <div>
          <h2>Scheduled health-check reliability</h2>
          <p>
            Recorded Azure health-check outcomes from the retrieved monitoring
            history.
          </p>
        </div>
        <span className="demo-tag">AZURE HISTORY</span>
      </div>

      <div className="metrics-grid">
        <article className="metric-card">
          <div className="metric-top">
            <span>SUCCESS RATE</span>
            <span>✓</span>
          </div>
          <strong style={{ color: '#68e0b5' }}>
            {stats.successRate == null
              ? 'N/A'
              : `${stats.successRate.toFixed(1)}%`}
          </strong>
          <p>
            {stats.classified} classified checks
          </p>
        </article>

        <article className="metric-card">
          <div className="metric-top">
            <span>READY CHECKS</span>
            <span>✓</span>
          </div>
          <strong style={{ color: '#68e0b5' }}>{stats.ready}</strong>
          <p>Recorded successful checks</p>
        </article>

        <article className="metric-card">
          <div className="metric-top">
            <span>DEGRADED CHECKS</span>
            <span>!</span>
          </div>
          <strong style={{ color: '#ff8b8b' }}>{stats.degraded}</strong>
          <p>Recorded degraded checks</p>
        </article>
      </div>

      <div style={{ marginTop: 24 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 10,
            fontSize: 13,
          }}
        >
          <span>READY vs DEGRADED</span>
          <span>{stats.classified} checks</span>
        </div>

        <div
          role="img"
          aria-label={`${stats.ready} READY checks and ${stats.degraded} DEGRADED checks`}
          style={{
            display: 'flex',
            height: 18,
            width: '100%',
            overflow: 'hidden',
            borderRadius: 9,
            background: '#263244',
          }}
        >
          {stats.classified > 0 && (
            <>
              {stats.ready > 0 && (
                <div
                  style={{
                    width: `${readyWidth}%`,
                    background: '#68e0b5',
                    transition: 'width 0.3s ease',
                  }}
                />
              )}

              {stats.degraded > 0 && (
                <div
                  style={{
                    width: `${degradedWidth}%`,
                    background: '#ff8b8b',
                    transition: 'width 0.3s ease',
                  }}
                />
              )}
            </>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 18,
            marginTop: 14,
            fontSize: 13,
          }}
        >
          <span>
            <span style={{ color: '#68e0b5' }}>●</span> READY: {stats.ready}
          </span>
          <span>
            <span style={{ color: '#ff8b8b' }}>●</span> DEGRADED: {stats.degraded}
          </span>
          <span>
            <span style={{ color: '#94a3b8' }}>●</span> Other/unknown: {stats.other}
          </span>
        </div>
      </div>

      {stats.classified === 0 && (
        <p style={{ marginTop: 16 }}>
          No READY or DEGRADED records were found in the retrieved history.
        </p>
      )}

      <p style={{ fontSize: 12, opacity: 0.75, marginTop: 20 }}>
        Success rate = READY ÷ (READY + DEGRADED) × 100. Other or unknown
        statuses are excluded from this percentage. The result reflects the
        retrieved records, not a guarantee of current availability.
      </p>

      <p style={{ fontSize: 12, opacity: 0.75 }}>
        Total records retrieved: {stats.total}
      </p>
    </section>
  )
}
