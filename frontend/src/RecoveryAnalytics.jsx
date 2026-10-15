
import { useMemo, useState } from 'react'

function formatDate(value) {
  if (!value) return 'Timestamp unavailable'

  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Timestamp unavailable'
    : date.toLocaleString()
}

export default function RecoveryAnalytics({ reports = [] }) {
  const [targetInput, setTargetInput] = useState('180')

  const target = Number(targetInput)
  const validTarget =
    targetInput.trim() !== '' &&
    Number.isFinite(target) &&
    target > 0

  const history = useMemo(() => {
    return reports
      .filter(
        report =>
          report.rto_seconds != null &&
          Number.isFinite(Number(report.rto_seconds)) &&
          Number(report.rto_seconds) >= 0,
      )
      .sort(
        (a, b) =>
          new Date(a.generated_at ?? 0).getTime() -
          new Date(b.generated_at ?? 0).getTime(),
      )
  }, [reports])

  const latest = reports[0] ?? null
  const latestRto =
    latest?.rto_seconds != null &&
    Number.isFinite(Number(latest.rto_seconds))
      ? Number(latest.rto_seconds)
      : null

  const recoverySucceeded = latest?.recovered === true
  const primaryRestored =
    latest?.primary_restoration?.restored === true

  const targetMet =
    validTarget &&
    latestRto != null &&
    latestRto <= target &&
    recoverySucceeded

  const maximumRto = Math.max(
    validTarget ? target : 0,
    ...history.map(report => Number(report.rto_seconds)),
    1,
  )

  return (
    <section className="placeholder-panel">
      <div className="section-heading">
        <div>
          <h2>Disaster recovery analytics</h2>
          <p>
            Recorded failover evidence and recovery-time performance.
          </p>
        </div>
        <span className="demo-tag">RECOVERY EVIDENCE</span>
      </div>

      <div className="metrics-grid">
        <article className="metric-card">
          <div className="metric-top">
            <span>LAST RECORDED RTO</span>
            <span>◷</span>
          </div>
          <strong>
            {latestRto == null ? 'N/A' : latestRto.toFixed(2)}
            {latestRto != null && (
              <small> sec</small>
            )}
          </strong>
          <p>Measured during the saved failover test</p>
        </article>

        <article className="metric-card">
          <div className="metric-top">
            <span>RECOVERY OUTCOME</span>
            <span>✓</span>
          </div>
          <strong
            style={{
              color: recoverySucceeded ? '#68e0b5' : '#ff8b8b',
            }}
          >
            {latest
              ? recoverySucceeded
                ? 'SUCCESS'
                : 'NOT CONFIRMED'
              : 'N/A'}
          </strong>
          <p>Based on the latest saved report</p>
        </article>

        <article className="metric-card">
          <div className="metric-top">
            <span>PRIMARY RESTORATION</span>
            <span>↺</span>
          </div>
          <strong
            style={{
              color: primaryRestored ? '#68e0b5' : '#ffbf69',
            }}
          >
            {latest
              ? primaryRestored
                ? 'RESTORED'
                : 'UNCONFIRMED'
              : 'N/A'}
          </strong>
          <p>Recorded restoration evidence</p>
        </article>
      </div>

      <div style={{ marginTop: 24 }}>
        <label
          htmlFor="rto-target"
          style={{ display: 'block', marginBottom: 8 }}
        >
          RTO target (seconds)
        </label>

        <input
          id="rto-target"
          type="number"
          min="0.01"
          step="1"
          value={targetInput}
          onChange={event => setTargetInput(event.target.value)}
          style={{
            width: '100%',
            maxWidth: 260,
            boxSizing: 'border-box',
            padding: '12px 14px',
            borderRadius: 8,
            border: '1px solid #334155',
            background: '#0b1220',
            color: '#f8fafc',
            fontSize: 16,
          }}
        />

        <p style={{ fontSize: 12, opacity: 0.75 }}>
          Change this target to evaluate the recorded recovery time against
          your chosen objective. This setting is local to this dashboard.
        </p>
      </div>

      <div
        style={{
          marginTop: 16,
          padding: 18,
          border: `1px solid ${
            !validTarget || latestRto == null
              ? '#64748b'
              : targetMet
                ? '#247b60'
                : '#b94b4b'
          }`,
          borderRadius: 12,
          background: '#0d1721',
        }}
      >
        <p style={{ marginTop: 0 }}>RTO target assessment</p>

        {!validTarget ? (
          <strong style={{ color: '#ffbf69' }}>
            Enter a target greater than zero.
          </strong>
        ) : latestRto == null ? (
          <strong style={{ color: '#ffbf69' }}>
            No valid RTO measurement is available in the latest report.
          </strong>
        ) : (
          <>
            <h3
              style={{
                color: targetMet ? '#68e0b5' : '#ff8b8b',
                margin: '8px 0',
              }}
            >
              {targetMet ? 'TARGET MET' : 'TARGET NOT MET'}
            </h3>

            <p>
              Recorded RTO: <strong>{latestRto.toFixed(2)} seconds</strong>
            </p>
            <p>
              Target: <strong>{target.toFixed(2)} seconds</strong>
            </p>
            <p>
              {latestRto <= target
                ? `${(target - latestRto).toFixed(2)} seconds below the target`
                : `${(latestRto - target).toFixed(2)} seconds above the target`}
            </p>

            {!recoverySucceeded && (
              <p>
                Recovery was not recorded as successful, so the target is
                not considered met.
              </p>
            )}
          </>
        )}
      </div>

      <div className="section-heading" style={{ marginTop: 28 }}>
        <div>
          <h2>Failover RTO history</h2>
          <p>
            Saved tests with valid recovery-time measurements, oldest to
            newest.
          </p>
        </div>
      </div>

      {history.length === 0 ? (
        <p>No saved failover reports with valid RTO measurements were found.</p>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {history.map((report, index) => {
            const rto = Number(report.rto_seconds)
            const recovered = report.recovered === true
            const restored =
              report.primary_restoration?.restored === true
            const meetsTarget =
              validTarget && rto <= target && recovered

            return (
              <article
                key={report.test_id ?? `${report.generated_at}-${index}`}
                style={{
                  padding: 16,
                  border: '1px solid #253449',
                  borderRadius: 10,
                  background: '#0d1721',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 10,
                  }}
                >
                  <strong>Failover test {index + 1}</strong>
                  <strong
                    style={{
                      color: recovered ? '#68e0b5' : '#ff8b8b',
                    }}
                  >
                    {recovered ? 'RECOVERED' : 'NOT RECOVERED'}
                  </strong>
                </div>

                <p style={{ fontSize: 12, opacity: 0.75 }}>
                  {formatDate(report.generated_at)}
                </p>

                <p>
                  RTO: <strong>{rto.toFixed(2)} seconds</strong>
                  {' · '}Primary restored:{' '}
                  <strong>{restored ? 'Yes' : 'Unconfirmed'}</strong>
                </p>

                <div
                  style={{
                    height: 10,
                    borderRadius: 6,
                    background: '#263244',
                    overflow: 'hidden',
                    marginTop: 12,
                  }}
                  aria-label={`RTO ${rto.toFixed(2)} seconds`}
                >
                  <div
                    style={{
                      width: `${Math.min(
                        (rto / maximumRto) * 100,
                        100,
                      )}%`,
                      height: '100%',
                      borderRadius: 6,
                      background: meetsTarget
                        ? '#68e0b5'
                        : '#78a9ff',
                    }}
                  />
                </div>

                {validTarget && (
                  <p style={{ fontSize: 12, opacity: 0.8 }}>
                    {meetsTarget
                      ? 'Within the current RTO target'
                      : rto > target
                        ? 'Above the current RTO target'
                        : 'Within time target, but recovery success is not confirmed'}
                  </p>
                )}

                {report.test_id && (
                  <p
                    style={{
                      fontSize: 11,
                      opacity: 0.65,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    Test ID: {report.test_id}
                  </p>
                )}
              </article>
            )
          })}
        </div>
      )}

      <p style={{ fontSize: 12, opacity: 0.7, marginTop: 20 }}>
        Only saved failover reports are used here. Scheduled health checks
        are not treated as failover tests. The RTO target is an editable
        dashboard setting and is not a configured Azure service objective.
      </p>
    </section>
  )
}
