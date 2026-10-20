export function ExportButton({
  getData,
  filename,
  disabled = false,
}: {
  getData: () => unknown;
  filename: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title="Export JSON"
      aria-label="Export JSON"
      disabled={disabled}
      className="p-1 text-zinc-500 hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"
      onClick={() => {
        const blob = new Blob([JSON.stringify(getData(), null, 2) + '\n'], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}
    >
      <svg
        aria-hidden="true"
        className="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />
      </svg>
    </button>
  );
}
