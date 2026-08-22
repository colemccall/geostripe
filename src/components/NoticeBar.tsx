import type { Notice } from '../store/useEditorStore';

/**
 * Inline feedback for file operations.
 *
 * Upload failures list every problem Zod found, with the field named, because "invalid
 * file" tells someone nothing they can act on. Errors stay until dismissed; successes
 * are just as visible but carry no detail list.
 */
export default function NoticeBar({
  notice,
  onDismiss,
}: {
  notice: Notice | null;
  onDismiss: () => void;
}) {
  if (!notice) return null;

  return (
    <div className={`notice notice-${notice.kind}`} role="status">
      <div className="notice-body">
        <strong>{notice.title}</strong>
        {notice.details && notice.details.length > 0 && (
          <ul>
            {notice.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="notice-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
