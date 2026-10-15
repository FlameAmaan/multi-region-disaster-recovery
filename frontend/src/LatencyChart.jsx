
import { useMemo, useState } from 'react'

const ENDPOINTS = [
  { key: 'primary', label: 'Primary VM', color: '#68e0b5' },
  { key: 'secondary', label: 'Secondary VM', color: '#78a9ff' },
  { key: 'traffic_manager', label: 'Traffic Manager', color: '#ffbf69' },
]

function parseReport(log) {
  try {
    const raw = log.report_json
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

function formatTime(value) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return 'Unknown time'

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function LatencyChart({ logs = [] }) {
  const [selectedPoint, setSelectedPoint] = useState(null)

  const points = useMemo(() => {
    return logs
      .map(log => {
        const report = parseReport(log)
        const health = report?.endpoint_health
        const timestamp = report?.generated_at ?? log.generated_at

        if (
          !health ||
          !timestamp ||
          Number.isNaN(new Date(timestamp).getTime())
        ) {
          return null
        }

        const values = {}

        ENDPOINTS.forEach(endpoint => {
          const rawValue = health[endpoint.key]?.latency_ms
          const value = Number(rawValue)

          values[endpoint.key] =
            rawValue != null && Number.isFinite(value) && value >= 0
              ? value
              : null
        })

        if (Object.values(values).every(value => value === null)) {
          return null
        }

        return { timestamp, ...values }
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() -
          new Date(b.timestamp).getTime(),
      )
      .slice(-20)
  }, [logs])

  const chart = useMemo(() => {
    const width = 760
    const height = 300
    const left = 60
    const right = 20
    const top = 25
    const bottom = 48
    const plotWidth = width - left - right
    const plotHeight = height - top - bottom

    const values = points.flatMap(point =>
      ENDPOINTS
        .map(endpoint => point[endpoint.key])
        .filter(value => value !== null),
    )

    const maxValue = Math.max(10, ...values)
    const yMaximum = Math.ceil(maxValue / 20) * 20

    const x = index =>
      points.length <= 1
        ? left + plotWidth / 2
        : left + (index / (points.length - 1)) * plotWidth

    const y = value =>
      top + plotHeight - (value / yMaximum) * plotHeight

    return {
      width,
      height,
      left,
      top,
      plotWidth,
      plotHeight,
      yMaximum,
      x,
      y,
    }
  }, [points])

  const activePoint = selectedPoint
    ? {
        ...selectedPoint,
        tooltipX: Math.max(
          chart.left + 4,
          Math.min(selectedPoint.x + 12, chart.width - 215),
        ),
        tooltipY: Math.max(
          chart.top + 4,
          Math.min(selectedPoint.y - 66, chart.height - 80),
        ),
      }
    : null

  if (points.length === 0) {
    return (
      <section className="placeholder-panel">
        <h2>Endpoint latency history</h2>
        <p>
          No usable latency measurements were found in the retrieved Azure
          records.
        </p>
      </section>
    )
  }

  return (
    <section className="placeholder-panel">
      <div className="section-heading">
        <div>
          <h2>Endpoint latency history</h2>
          <p>
            Actual latency measurements from Azure scheduled health checks.
            Showing up to {points.length} recorded samples.
          </p>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          marginBottom: 12,
        }}
      >
        {ENDPOINTS.map(endpoint => (
          <div
            key={endpoint.key}
            style={{ display: 'flex', alignItems: 'center', gap: 7 }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: endpoint.color,
              }}
            />
            <span>{endpoint.label}</span>
          </div>
        ))}
      </div>

      <p style={{ fontSize: 12, opacity: 0.75 }}>
        Hover over a point or click/tap it to inspect the measurement.
      </p>

      <div style={{ width: '100%', overflowX: 'auto' }}>
        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label="Historical endpoint latency in milliseconds"
          style={{
            width: '100%',
            minWidth: 340,
            display: 'block',
          }}
          onMouseLeave={() => setSelectedPoint(null)}
        >
          {[0, 0.25, 0.5, 0.75, 1].map(fraction => {
            const value = chart.yMaximum * fraction
            const y = chart.y(value)

            return (
              <g key={fraction} pointerEvents="none">
                <line
                  x1={chart.left}
                  x2={chart.left + chart.plotWidth}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  opacity="0.12"
                />
                <text
                  x={chart.left - 10}
                  y={y + 4}
                  fontSize="11"
                  textAnchor="end"
                  fill="currentColor"
                  opacity="0.75"
                >
                  {Math.round(value)}
                </text>
              </g>
            )
          })}

          <text
            x="15"
            y={chart.top + chart.plotHeight / 2}
            transform={`rotate(-90 15 ${chart.top + chart.plotHeight / 2})`}
            fontSize="11"
            fill="currentColor"
            textAnchor="middle"
          >
            Latency (ms)
          </text>

          {points.map((point, index) => {
            if (
              index !== 0 &&
              index !== points.length - 1 &&
              index % Math.ceil(points.length / 5) !== 0
            ) {
              return null
            }

            return (
              <text
                key={`${point.timestamp}-${index}`}
                x={chart.x(index)}
                y={chart.top + chart.plotHeight + 23}
                fontSize="10"
                textAnchor="middle"
                fill="currentColor"
                opacity="0.8"
                pointerEvents="none"
              >
                {new Date(point.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </text>
            )
          })}

          {ENDPOINTS.map(endpoint => {
            const segments = []
            let current = []

            points.forEach((point, index) => {
              const value = point[endpoint.key]

              if (value === null) {
                if (current.length > 0) {
                  segments.push(current)
                }
                current = []
                return
              }

              current.push({
                x: chart.x(index),
                y: chart.y(value),
                value,
                timestamp: point.timestamp,
                endpoint: endpoint.label,
                endpointKey: endpoint.key,
                color: endpoint.color,
                index,
              })
            })

            if (current.length > 0) {
              segments.push(current)
            }

            return (
              <g key={endpoint.key}>
                {segments.map((segment, segmentIndex) => (
                  <g key={segmentIndex}>
                    {segment.length > 1 && (
                      <polyline
                        points={segment
                          .map(point => `${point.x},${point.y}`)
                          .join(' ')}
                        fill="none"
                        stroke={endpoint.color}
                        strokeWidth="2.5"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        pointerEvents="none"
                      />
                    )}

                    {segment.map(point => {
                      const isActive =
                        selectedPoint?.endpointKey === point.endpointKey &&
                        selectedPoint?.index === point.index

                      return (
                        <g key={`${point.timestamp}-${point.index}`}>
                          {isActive && (
                            <circle
                              cx={point.x}
                              cy={point.y}
                              r="8"
                              fill={point.color}
                              opacity="0.22"
                              pointerEvents="none"
                            />
                          )}

                          <circle
                            cx={point.x}
                            cy={point.y}
                            r={isActive ? 5 : 4}
                            fill={point.color}
                            stroke={isActive ? '#ffffff' : 'none'}
                            strokeWidth="1.5"
                            style={{ cursor: 'pointer' }}
                            role="button"
                            tabIndex={0}
                            aria-label={`${point.endpoint}: ${point.value} milliseconds at ${formatTime(point.timestamp)}`}
                            onMouseEnter={() => setSelectedPoint(point)}
                            onFocus={() => setSelectedPoint(point)}
                            onBlur={() => setSelectedPoint(null)}
                            onClick={event => {
                              event.stopPropagation()
                              setSelectedPoint(current =>
                                current?.endpointKey === point.endpointKey &&
                                current?.index === point.index
                                  ? null
                                  : point,
                              )
                            }}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                setSelectedPoint(point)
                              }

                              if (event.key === 'Escape') {
                                setSelectedPoint(null)
                              }
                            }}
                          />
                        </g>
                      )
                    })}
                  </g>
                ))}
              </g>
            )
          })}

          {activePoint && (
            <g pointerEvents="none">
              <rect
                x={activePoint.tooltipX}
                y={activePoint.tooltipY}
                width="204"
                height="67"
                rx="8"
                fill="#17212e"
                stroke={activePoint.color}
                strokeWidth="1.2"
              />
              <text
                x={activePoint.tooltipX + 10}
                y={activePoint.tooltipY + 18}
                fontSize="12"
                fontWeight="600"
                fill={activePoint.color}
              >
                {activePoint.endpoint}
              </text>
              <text
                x={activePoint.tooltipX + 10}
                y={activePoint.tooltipY + 36}
                fontSize="12"
                fill="#ffffff"
              >
                {activePoint.value.toFixed(2)} ms
              </text>
              <text
                x={activePoint.tooltipX + 10}
                y={activePoint.tooltipY + 53}
                fontSize="10"
                fill="#cbd5e1"
              >
                {formatTime(activePoint.timestamp)}
              </text>
            </g>
          )}
        </svg>
      </div>

      <p style={{ opacity: 0.75, fontSize: 12 }}>
        Lower latency is better. Missing measurements are left blank rather
        than treated as zero. Click a point to inspect its measurement.
      </p>
    </section>
  )
}
