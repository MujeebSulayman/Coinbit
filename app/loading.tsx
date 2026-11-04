/** Shown instantly while a page's server data loads, so navigation never feels frozen. */
export default function Loading() {
  return (
    <div className="space-y-4 md:space-y-5" aria-busy="true" aria-label="Loading">
      <div className="space-y-2 pb-1">
        <div className="skeleton h-6 w-40" />
        <div className="skeleton h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2 bg-panel px-4 py-3.5">
            <div className="skeleton h-3 w-16" />
            <div className="skeleton h-5 w-24" />
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex h-11 items-center border-b border-line px-4">
          <div className="skeleton h-4 w-28" />
        </div>
        <div className="divide-y divide-line">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="skeleton size-6 rounded-full" />
              <div className="skeleton h-4 w-24" />
              <div className="skeleton ml-auto h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
