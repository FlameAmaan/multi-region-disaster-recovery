import LatencyChart from './LatencyChart'
import { useEffect, useState } from 'react'
import './App.css'
import ReliabilityChart from './ReliabilityChart'
import RecoveryAnalytics from './RecoveryAnalytics'

const API = 'http://127.0.0.1:8000'
const STALE_AFTER_MINUTES = 10

const services = [
  { name: 'Primary Server', region: 'India South Central', id: 'primary' },
  { name: 'Secondary Server', region: 'Central India', id: 'secondary' },
  { name: 'Traffic Manager', region: 'Global routing', id: 'traffic_manager' },
]

function formatDate(value) {
  if (!value) return 'Timestamp unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Timestamp unavailable'
    : date.toLocaleString()
}

function getAgeMinutes(value, now) {
  if (!value) return null
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return null
  const difference = now - timestamp
  if (difference < 0) return 0
  return Math.floor(difference / 60000)
}

function formatAge(minutes) {
  if (minutes == null) return 'Unknown'
  if (minutes < 1) return 'Less than 1 minute'
  if (minutes === 1) return '1 minute'
  return `${minutes} minutes`
}

function App() {
  const [activeTab, setActiveTab] = useState('Overview')
  const [apiOnline, setApiOnline] = useState(false)
  const [report, setReport] = useState(null)
  const [failovers, setFailovers] = useState([])
  const [liveData, setLiveData] = useState(null)
  const [azureLogs, setAzureLogs] = useState([])
  const [azureLogStatus, setAzureLogStatus] = useState('loading')
  const [azureLogMessage, setAzureLogMessage] = useState('')
  const [error, setError] = useState('')
  const [lastRefresh, setLastRefresh] = useState(null)
  const [clock, setClock] = useState(Date.now())

  const [failoverRunning, setFailoverRunning] = useState(false)
  const [failoverMessage, setFailoverMessage] = useState('')
  const [failoverResult, setFailoverResult] = useState(null)

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadDashboard() {
      try {
        const [
          healthResponse,
          statusResponse,
          failoverResponse,
          liveResponse,
        ] = await Promise.all([
          fetch(`${API}/api/health`),
          fetch(`${API}/api/status`),
          fetch(`${API}/api/failover`),
          fetch(`${API}/api/live`),
        ])

        if (
          !healthResponse.ok ||
          !statusResponse.ok ||
          !failoverResponse.ok ||
          !liveResponse.ok
        ) {
          throw new Error('Backend request failed.')
        }

        const [health, status, history, live] = await Promise.all([
          healthResponse.json(),
          statusResponse.json(),
          failoverResponse.json(),
          liveResponse.json(),
        ])

        if (cancelled) return

        setApiOnline(health.api_status === 'online')
        setReport(status.report ?? null)
        setFailovers(history.reports ?? [])
        setLiveData(live)

        setError(
          status.data_status === 'unavailable'
            ? 'No saved health report is available.'
            : '',
        )

        setLastRefresh(new Date())
      } catch {
        if (cancelled) return

        setApiOnline(false)
        setError(
          'Cannot reach the backend. Make sure the API is running on port 8000.',
        )
      }

      // Fetch Azure history independently from live monitoring.
      try {
        const response = await fetch(`${API}/api/azure-logs`)
        if (!response.ok) throw new Error('Azure logs request failed.')

        const data = await response.json()
        if (cancelled) return

        if (data.data_status === 'connected') {
          setAzureLogs(data.logs ?? [])
          setAzureLogStatus('connected')
          setAzureLogMessage('')
        } else {
          setAzureLogs([])
          setAzureLogStatus(data.data_status ?? 'error')
          setAzureLogMessage(
            data.message ?? 'Azure monitoring logs are unavailable.',
          )
        }
      } catch {
        if (cancelled) return

        setAzureLogStatus('error')
        setAzureLogMessage(
          'Could not load Azure logs. Live endpoint monitoring can continue.',
        )
      }
    }

    loadDashboard()
    const interval = setInterval(loadDashboard, 10000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const storedResults = report?.results ?? []
  const liveResults = liveData?.results ?? []
  const liveHealthyCount = liveResults.filter(item => item.healthy).length
  const latestFailover = failovers[0]
  const rto = latestFailover?.rto_seconds ?? report?.rto_seconds

  const liveEndpointStatus = id =>
    liveResults.find(item => item.endpoint === id)

  const overallStatus = liveData?.summary?.overall_status

  const statusColor =
    overallStatus === 'READY'
      ? '#68e0b5'
      : overallStatus === 'DEGRADED'
        ? '#ff8b8b'
        : '#94a3b8'

  // The API sorts Azure logs newest first.
  const latestAzureLog = azureLogs[0]

  const azureAgeMinutes = getAgeMinutes(
    latestAzureLog?.generated_at,
    clock,
  )

  const azureFreshness =
    azureLogStatus !== 'connected' || azureAgeMinutes == null
      ? 'UNAVAILABLE'
      : azureAgeMinutes > STALE_AFTER_MINUTES
        ? 'STALE'
        : 'FRESH'

  const freshnessColor =
    azureFreshness === 'FRESH'
      ? '#68e0b5'
      : azureFreshness === 'STALE'
        ? '#ffbf69'
        : '#ff8b8b'

  const azureRecordedStatus = String(
    latestAzureLog?.status ?? 'UNKNOWN',
  ).toUpperCase()

  const azureRecordedHealthy =
    azureRecordedStatus === 'READY' &&
    latestAzureLog?.healthy_endpoints != null &&
    latestAzureLog?.total_endpoints != null &&
    Number(latestAzureLog.healthy_endpoints) ===
      Number(latestAzureLog.total_endpoints)

  async function runFailover() {
    if (failoverRunning) return

    const confirmed = window.confirm(
      'WARNING: This test will deallocate the PRIMARY Azure VM. ' +
      'Traffic Manager should route traffic to the secondary. ' +
      'The dashboard will attempt to restart the primary afterward. ' +
      'This affects real Azure infrastructure and may interrupt traffic. ' +
      'Proceed with the real failover test?',
    )

    if (!confirmed) return

    setFailoverRunning(true)
    setFailoverMessage('Checking prerequisites...')
    setFailoverResult(null)

    try {
      setFailoverMessage(
        'Failover in progress. Waiting for Traffic Manager to serve the secondary...',
      )

      const response = await fetch(`${API}/api/failover/run`, {
        method: 'POST',
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(
          typeof data.detail === 'string'
            ? data.detail
            : 'Failover test could not start.',
        )
      }

      setFailoverResult(data.report ?? null)
      setFailoverMessage(data.message || 'Failover test completed.')

      const [historyResponse, liveResponse] = await Promise.all([
        fetch(`${API}/api/failover`),
        fetch(`${API}/api/live`),
      ])

      if (historyResponse.ok) {
        const history = await historyResponse.json()
        setFailovers(history.reports ?? [])
      }

      if (liveResponse.ok) {
        setLiveData(await liveResponse.json())
      }
    } catch (err) {
      setFailoverMessage(
        err.message || 'Could not complete the failover test.',
      )
    } finally {
      setFailoverRunning(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">DR</div>
          <div>
            <h2>
              Sentinel<span>DR</span>
            </h2>
            <small>RECOVERY CONTROL CENTER</small>
          </div>
        </div>

        <p className="nav-label">WORKSPACE</p>

        {['Overview', 'Infrastructure', 'Failover Tests', 'Event Logs'].map(tab => (
          <button
            key={tab}
            className={`nav-item ${activeTab === tab ? 'selected' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <span>
              {{
                Overview: '◈',
                Infrastructure: '▦',
                'Failover Tests': '⟳',
                'Event Logs': '≡',
              }[tab]}
            </span>
            {tab}
          </button>
        ))}

        <div className="sidebar-bottom">
          <div className="connection-dot" />
          <div>
            <strong>{apiOnline ? 'Backend connected' : 'Backend offline'}</strong>
            <small>{apiOnline ? 'Local API responding' : 'Check port 8000'}</small>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">
              DISASTER RECOVERY / {activeTab.toUpperCase()}
            </p>
            <h1>{activeTab}</h1>
          </div>
          <div className="top-status">
            <span />
            {apiOnline ? 'API connected' : 'API disconnected'}
          </div>
        </header>

        <section className="welcome">
          <div>
            <p className="eyebrow">MULTI-REGION RESILIENCE</p>
            <h2>
              Your infrastructure, <span>under control.</span>
            </h2>
            <p>
              Monitor regional health, review recovery evidence, and inspect
              your disaster recovery setup.
            </p>
          </div>
          <div className="welcome-symbol">⌘</div>
        </section>

        {error && (
          <section className="placeholder-panel">
            <h2>Dashboard notice</h2>
            <p>{error}</p>
          </section>
        )}

        {activeTab === 'Overview' && (
          <>
            <div className="section-heading">
              <div>
                <h2>Infrastructure overview</h2>
                <p>Live endpoint checks plus historical recovery evidence</p>
              </div>
              <span className="demo-tag">LIVE HEALTH</span>
            </div>

            <div
              className="placeholder-panel"
              style={{ borderColor: statusColor, borderWidth: '1px' }}
            >
              <h2>Live monitoring status</h2>
              <p>
                Overall status:{' '}
                <strong style={{ color: statusColor }}>
                  {overallStatus ?? 'CHECKING'}
                </strong>
                {' · '}Last checked:{' '}
                <strong>{formatDate(liveData?.checked_at)}</strong>
              </p>
              <p>
                Healthy endpoints: {liveHealthyCount} / {liveResults.length || 3}
                {' · '}Unhealthy endpoints:{' '}
                {liveData?.summary?.unhealthy_endpoints ?? '—'}
              </p>
              <p>
                Read-only HTTP checks run every 10 seconds. An unhealthy result
                does not automatically trigger failover.
              </p>
            </div>

            {/* Azure freshness and recorded health summary */}
            <div className="section-heading">
              <div>
                <h2>Azure monitoring freshness</h2>
                <p>Age and outcome of the latest scheduled Azure check</p>
              </div>
              <span
                className="demo-tag"
                style={{
                  color: freshnessColor,
                  borderColor: freshnessColor,
                }}
              >
                {azureFreshness}
              </span>
            </div>

            <div
              className="placeholder-panel"
              style={{ borderColor: freshnessColor, borderWidth: '1px' }}
            >
              <div className="metrics-grid">
                <article className="metric-card">
                  <div className="metric-top">
                    <span>DATA FRESHNESS</span>
                    <span>◷</span>
                  </div>
                  <strong style={{ color: freshnessColor }}>
                    {azureAgeMinutes == null
                      ? 'N/A'
                      : formatAge(azureAgeMinutes)}
                  </strong>
                  <p>
                    {azureFreshness === 'FRESH'
                      ? 'Latest scheduled record is within the 10-minute threshold'
                      : azureFreshness === 'STALE'
                        ? 'Latest scheduled record is overdue'
                        : 'Unable to verify Azure record freshness'}
                  </p>
                </article>

                <article className="metric-card">
                  <div className="metric-top">
                    <span>LAST AZURE RESULT</span>
                    <span>✓</span>
                  </div>
                  <strong
                    style={{
                      color: azureRecordedHealthy ? '#68e0b5' : '#ffbf69',
                    }}
                  >
                    {azureLogStatus === 'connected'
                      ? azureRecordedStatus
                      : 'N/A'}
                  </strong>
                  <p>
                    Recorded endpoints:{' '}
                    {latestAzureLog
                      ? `${latestAzureLog.healthy_endpoints ?? 'N/A'} / ${latestAzureLog.total_endpoints ?? 'N/A'}`
                      : 'No record available'}
                  </p>
                </article>

                <article className="metric-card">
                  <div className="metric-top">
                    <span>AZURE LOG RECORDS</span>
                    <span>▤</span>
                  </div>
                  <strong>
                    {azureLogStatus === 'connected' ? azureLogs.length : 'N/A'}
                  </strong>
                  <p>
                    {azureLogStatus === 'connected'
                      ? 'Recent scheduled records retrieved'
                      : azureLogMessage || 'Azure logs unavailable'}
                  </p>
                </article>
              </div>

              <p>
                Latest Azure record timestamp:{' '}
                <strong>{formatDate(latestAzureLog?.generated_at)}</strong>
              </p>
              <p>
                Dashboard refreshed:{' '}
                <strong>
                  {lastRefresh ? lastRefresh.toLocaleTimeString() : 'Waiting...'}
                </strong>
              </p>
              <p>
                Freshness threshold: {STALE_AFTER_MINUTES} minutes. This
                measures record age, not the actual health of the
                infrastructure at this instant.
              </p>
            </div>

            <LatencyChart logs={azureLogs} />
            <ReliabilityChart logs={azureLogs} />
            <RecoveryAnalytics reports={failovers} />

            <div className="metrics-grid">
              <article className="metric-card">
                <div className="metric-top">
                  <span>LIVE ENDPOINT HEALTH</span>
                  <span>▦</span>
                </div>
                <strong>
                  {String(liveHealthyCount).padStart(2, '0')}
                  <small> / {liveResults.length || 3}</small>
                </strong>
                <p>
                  {overallStatus === 'READY'
                    ? 'All live endpoint checks passed'
                    : overallStatus === 'DEGRADED'
                      ? 'One or more endpoints are unhealthy'
                      : 'Waiting for live check results'}
                </p>
              </article>

              <article className="metric-card">
                <div className="metric-top">
                  <span>LAST RECORDED RTO</span>
                  <span>◷</span>
                </div>
                <strong>
                  {rto != null ? Number(rto).toFixed(2) : 'N/A'}
                  <small>{rto != null ? ' sec' : ''}</small>
                </strong>
                <p>From the recorded failover test</p>
              </article>

              <article className="metric-card">
                <div className="metric-top">
                  <span>FUNCTION SCHEDULE</span>
                  <span>⌁</span>
                </div>
                <strong>
                  5 <small>min</small>
                </strong>
                <p>Configured Azure health-check interval</p>
              </article>
            </div>

            <div className="section-heading">
              <div>
                <h2>Regional infrastructure</h2>
                <p>Current HTTP checks from the dashboard backend</p>
              </div>
            </div>

            <div className="server-grid">
              {services.map(service => {
                const result = liveEndpointStatus(service.id)
                const healthy = result?.healthy

                const tagStyle = {
                  borderColor: result
                    ? healthy
                      ? '#247b60'
                      : '#b94b4b'
                    : '#64748b',
                  color: result
                    ? healthy
                      ? '#68e0b5'
                      : '#ff8b8b'
                    : '#94a3b8',
                  background: result
                    ? healthy
                      ? 'rgba(30, 140, 100, 0.14)'
                      : 'rgba(185, 75, 75, 0.14)'
                    : 'rgba(100, 116, 139, 0.14)',
                }

                return (
                  <article className="server-card" key={service.id}>
                    <div className="server-card-head">
                      <div className="server-icon">
                        {service.id === 'traffic_manager' ? '⇄' : '▣'}
                      </div>
                      <span className="configured-tag" style={tagStyle}>
                        {result
                          ? healthy
                            ? '● LIVE HEALTHY'
                            : '● LIVE UNHEALTHY'
                          : '○ CHECK PENDING'}
                      </span>
                    </div>

                    <h3>{service.name}</h3>
                    <p>{service.region}</p>
                    <div className="card-divider" />

                    <div className="server-foot">
                      <span>
                        {result
                          ? `HTTP ${result.status_code ?? 'N/A'} · ${result.latency_ms ?? 'N/A'} ms`
                          : 'Waiting for endpoint check'}
                      </span>
                      <span className="arrow">↗</span>
                    </div>

                    {result?.error && (
                      <p style={{ color: '#ff8b8b' }}>
                        Error: {result.error}
                      </p>
                    )}

                    {result?.observed_region &&
                      service.id === 'traffic_manager' && (
                        <p>Currently routed to: {result.observed_region}</p>
                      )}

                    {result?.checked_at && (
                      <p>
                        Checked at:{' '}
                        {new Date(result.checked_at).toLocaleTimeString()}
                      </p>
                    )}
                  </article>
                )
              })}
            </div>

            <div className="section-heading">
              <div>
                <h2>Recovery evidence</h2>
                <p>Most recent saved failover result</p>
              </div>
            </div>

            <article className="evidence-card">
              <div className="evidence-icon">
                {latestFailover?.recovered ? '✓' : '?'}
              </div>
              <div className="evidence-copy">
                <h3>
                  {latestFailover
                    ? latestFailover.recovered
                      ? 'Failover test recovered successfully'
                      : 'Failover recovery was unsuccessful'
                    : 'No failover report found'}
                </h3>
                <p>
                  {latestFailover
                    ? `Primary restoration: ${latestFailover.primary_restoration?.restored ? 'confirmed' : 'not confirmed'}. Report time: ${formatDate(latestFailover.generated_at)}`
                    : 'Run a failover test to generate recovery evidence.'}
                </p>
              </div>
              <div className="evidence-rto">
                <small>MEASURED RTO</small>
                <strong>
                  {latestFailover?.rto_seconds != null
                    ? `${Number(latestFailover.rto_seconds).toFixed(2)} s`
                    : 'N/A'}
                </strong>
              </div>
            </article>

            <div className="placeholder-panel">
              <h2>Data freshness</h2>
              <p>
                Live checks completed:{' '}
                <strong>{formatDate(liveData?.checked_at)}</strong>
              </p>
              <p>
                Dashboard last refreshed:{' '}
                <strong>
                  {lastRefresh ? lastRefresh.toLocaleTimeString() : 'Waiting...'}
                </strong>
              </p>
              <p>
                Saved health report generated:{' '}
                <strong>{formatDate(report?.generated_at)}</strong>
              </p>
              <p>
                Latest Azure scheduled check:{' '}
                <strong>{formatDate(latestAzureLog?.generated_at)}</strong>
              </p>
            </div>
          </>
        )}

        {activeTab === 'Infrastructure' && (
          <section className="placeholder-panel">
            <h2>Infrastructure inventory</h2>
            <p>
              Live checks are performed against two regional VMs and Azure
              Traffic Manager.
            </p>
            {liveResults.map(result => (
              <p key={result.endpoint}>
                <strong>{result.endpoint}</strong>: {result.url}
                {' · '}
                {result.healthy ? 'Live healthy' : 'Live unhealthy'}
                {' · '}
                {result.latency_ms != null
                  ? `${result.latency_ms} ms`
                  : 'Latency unavailable'}
                {result.error ? ` · ${result.error}` : ''}
              </p>
            ))}
            <p>Last live check: {formatDate(liveData?.checked_at)}</p>
          </section>
        )}

        {activeTab === 'Failover Tests' && (
          <>
            <section className="placeholder-panel">
              <h2>Controlled failover test</h2>
              <p>
                This test temporarily deallocates the primary Azure VM, measures
                how long Traffic Manager takes to serve the secondary, and then
                attempts to start the primary VM again. It affects real Azure
                infrastructure and may interrupt traffic.
              </p>

              <button
                type="button"
                onClick={runFailover}
                disabled={failoverRunning}
                style={{
                  padding: '12px 18px',
                  borderRadius: 8,
                  border: '1px solid #b94b4b',
                  background: failoverRunning ? '#475569' : '#8f2929',
                  color: '#ffffff',
                  fontWeight: 700,
                  cursor: failoverRunning ? 'wait' : 'pointer',
                  opacity: failoverRunning ? 0.75 : 1,
                }}
              >
                {failoverRunning
                  ? 'Failover test running...'
                  : '⚠ Run failover test'}
              </button>

              {failoverMessage && (
                <p
                  role="status"
                  aria-live="polite"
                  style={{ marginTop: 14 }}
                >
                  {failoverMessage}
                </p>
              )}

              {failoverResult && (
                <div style={{ marginTop: 16 }}>
                  <h3>
                    {failoverResult.recovered
                      ? 'Secondary recovery confirmed'
                      : 'Recovery not confirmed'}
                  </h3>

                  <p>
                    <strong>Measured RTO:</strong>{' '}
                    {failoverResult.rto_seconds != null
                      ? `${Number(failoverResult.rto_seconds).toFixed(2)} seconds`
                      : 'Not established'}
                  </p>

                  <p>
                    <strong>Primary restoration:</strong>{' '}
                    {failoverResult.primary_restoration?.restored
                      ? 'Confirmed'
                      : 'Not confirmed'}
                  </p>

                  <p>
                    <strong>Azure report upload:</strong>{' '}
                    {failoverResult.azure_upload?.uploaded
                      ? 'Successful'
                      : 'Failed or not configured'}
                  </p>

                  <p>Test ID: {failoverResult.test_id}</p>

                  {failoverResult.recovery_error && (
                    <p>Recovery detail: {failoverResult.recovery_error}</p>
                  )}

                  {failoverResult.primary_restoration?.error &&
                    !failoverResult.primary_restoration.restored && (
                      <p>
                        Restoration detail:{' '}
                        {failoverResult.primary_restoration.error}
                      </p>
                    )}
                </div>
              )}
            </section>

            <section className="placeholder-panel">
              <h2>Failover test history</h2>

              {failovers.length === 0 && (
                <p>No saved failover reports found.</p>
              )}

              {failovers.map(item => (
                <article className="evidence-card" key={item.test_id}>
                  <div className="evidence-icon">
                    {item.recovered ? '✓' : '!'}
                  </div>
                  <div className="evidence-copy">
                    <h3>
                      {item.recovered
                        ? 'Recovery successful'
                        : 'Recovery unsuccessful'}
                    </h3>
                    <p>
                      {formatDate(item.generated_at)} · Test ID: {item.test_id}
                    </p>
                    <p>
                      Primary restoration:{' '}
                      {item.primary_restoration?.restored
                        ? 'confirmed'
                        : 'not confirmed'}
                    </p>
                  </div>
                  <div className="evidence-rto">
                    <small>RTO</small>
                    <strong>
                      {item.rto_seconds != null
                        ? `${Number(item.rto_seconds).toFixed(2)} s`
                        : 'N/A'}
                    </strong>
                  </div>
                </article>
              ))}
            </section>
          </>
        )}

        {activeTab === 'Event Logs' && (
          <>
            <div className="section-heading">
              <div>
                <h2>Azure monitoring history</h2>
                <p>
                  Scheduled health-check records stored in Azure Table Storage
                </p>
              </div>
              <span className="demo-tag">
                {azureLogStatus === 'connected'
                  ? 'AZURE CONNECTED'
                  : azureLogStatus.toUpperCase()}
              </span>
            </div>

            <section className="placeholder-panel">
              <h2>Azure Table Storage · DRTestLogs</h2>
              <p>
                Connection status:{' '}
                <strong
                  style={{
                    color:
                      azureLogStatus === 'connected' ? '#68e0b5' : '#ff8b8b',
                  }}
                >
                  {azureLogStatus === 'connected'
                    ? 'CONNECTED'
                    : azureLogStatus === 'loading'
                      ? 'LOADING'
                      : 'UNAVAILABLE'}
                </strong>
              </p>

              <p>
                Records retrieved: <strong>{azureLogs.length}</strong>
              </p>
              <p>
                Latest recorded check:{' '}
                <strong>{formatDate(latestAzureLog?.generated_at)}</strong>
              </p>
              <p>
                Record age:{' '}
                <strong style={{ color: freshnessColor }}>
                  {formatAge(azureAgeMinutes)}
                </strong>
                {' · '}
                Freshness:{' '}
                <strong style={{ color: freshnessColor }}>
                  {azureFreshness}
                </strong>
              </p>

              {azureLogMessage && (
                <p style={{ color: '#ff8b8b' }}>{azureLogMessage}</p>
              )}

              {azureLogStatus === 'connected' && azureLogs.length === 0 && (
                <p>No scheduled health-check records were returned.</p>
              )}

              {azureLogs.map((log, index) => {
                const healthy =
                  String(log.status ?? '').toUpperCase() === 'READY'

                return (
                  <article
                    className="evidence-card"
                    key={`${log.generated_at ?? 'log'}-${index}`}
                  >
                    <div className="evidence-icon">
                      {healthy ? '✓' : '!'}
                    </div>
                    <div className="evidence-copy">
                      <h3>
                        {log.test_type || 'Health check'} ·{' '}
                        <span
                          style={{
                            color: healthy ? '#68e0b5' : '#ff8b8b',
                          }}
                        >
                          {log.status || 'UNKNOWN'}
                        </span>
                      </h3>
                      <p>Recorded at: {formatDate(log.generated_at)}</p>
                      <p>
                        Healthy endpoints: {log.healthy_endpoints ?? 'N/A'} /{' '}
                        {log.total_endpoints ?? 'N/A'}
                      </p>
                    </div>
                    <div className="evidence-rto">
                      <small>RESULT</small>
                      <strong>{healthy ? 'READY' : 'CHECK'}</strong>
                    </div>
                  </article>
                )
              })}
            </section>

            <div className="section-heading">
              <div>
                <h2>Live endpoint events</h2>
                <p>Separate checks performed by the dashboard backend</p>
              </div>
            </div>

            <section className="placeholder-panel">
              <p>Latest live check: {formatDate(liveData?.checked_at)}</p>

              {liveResults.map(result => (
                <p key={result.endpoint}>
                  <strong>{result.endpoint}</strong>
                  {' · '}
                  {result.healthy ? 'Live healthy' : 'Live unhealthy'}
                  {' · '}
                  Checked: {formatDate(result.checked_at)}
                  {result.error ? ` · Error: ${result.error}` : ''}
                </p>
              ))}

              <h2>Stored health report</h2>
              <p>Latest saved report: {formatDate(report?.generated_at)}</p>

              {storedResults.map(result => (
                <p key={`stored-${result.endpoint}`}>
                  <strong>{result.endpoint}</strong>
                  {' · '}
                  {result.healthy ? 'Recorded healthy' : 'Recorded unhealthy'}
                  {' · '}
                  Checked: {formatDate(result.checked_at)}
                </p>
              ))}
            </section>
          </>
        )}

        <footer>
          SentinelDR <span>•</span> Multi-Region Disaster Recovery Project
        </footer>
      </main>
    </div>
  )
}

export default App