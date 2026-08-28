export function SendButton({ disabled }: { readonly disabled: boolean }) {
  return (
    <button className="composer-send" type="submit" aria-label="Send" disabled={disabled}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M12.33 7.33a.75.75 0 0 0 0-1.06l-3.8-3.8a.75.75 0 0 0-1.06 0l-3.8 3.8a.75.75 0 0 0 1.06 1.06l2.52-2.52V13a.75.75 0 0 0 1.5 0V4.81l2.52 2.52a.75.75 0 0 0 1.06 0Z" />
      </svg>
    </button>
  )
}

export function StopButton({
  disabled,
  onStop,
}: {
  readonly disabled: boolean
  readonly onStop: () => void
}) {
  return (
    <button
      className="composer-stop"
      type="button"
      aria-label="Stop"
      disabled={disabled}
      onClick={onStop}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="4.5" y="4.5" width="7" height="7" rx="1.25" />
      </svg>
    </button>
  )
}
