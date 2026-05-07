export function DeliverabilityLoading() {
  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500 flex items-center gap-2">
        <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
        Running ClickHouse queries against yesterday&apos;s enterprise sends —
        first cold load can take up to a minute.
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-8" />
            <col className="w-[10%]" />
            <col className="w-[24%]" />
            <col className="w-[34%] hidden md:table-cell" />
            <col className="w-[10%]" />
            <col className="w-[14%] hidden lg:table-cell" />
          </colgroup>
          <thead className="bg-gray-50">
            <tr className="text-left border-b border-gray-200">
              <th className="px-3 py-3"></th>
              <th className="px-3 py-3 font-medium text-gray-600">Severity</th>
              <th className="px-3 py-3 font-medium text-gray-600">Workspace</th>
              <th className="px-3 py-3 font-medium text-gray-600 hidden md:table-cell">
                Subject
              </th>
              <th className="px-3 py-3 font-medium text-gray-600 text-right">
                Sent
              </th>
              <th className="px-3 py-3 font-medium text-gray-600 hidden lg:table-cell">
                CSM
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="px-3 py-3">
                  <SkeletonBar w="w-2 h-3" />
                </td>
                <td className="px-3 py-3">
                  <SkeletonBar w="w-16 h-4" />
                </td>
                <td className="px-3 py-3">
                  <SkeletonBar w="w-32 h-4" />
                  <SkeletonBar w="w-24 h-3 mt-1" />
                </td>
                <td className="px-3 py-3 hidden md:table-cell">
                  <SkeletonBar w="w-full h-4" />
                </td>
                <td className="px-3 py-3 text-right">
                  <SkeletonBar w="w-12 h-4 ml-auto" />
                </td>
                <td className="px-3 py-3 hidden lg:table-cell">
                  <SkeletonBar w="w-20 h-4" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SkeletonBar({ w }: { w: string }) {
  return (
    <div
      className={`bg-gray-200 rounded animate-pulse inline-block ${w}`}
    />
  );
}
