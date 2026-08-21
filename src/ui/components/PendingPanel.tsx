import type { ClientCommand, PendingRequest } from '../../shared/wire';

interface PendingPanelProps {
  pending: PendingRequest[];
  send: (command: ClientCommand) => void;
}

interface PermissionOption {
  optionId?: string;
  name?: string;
  kind?: string;
}

/**
 * Agent-initiated requests the inspector is holding open.
 *
 * This panel is the difference between a working inspector and a hang: if
 * `session/request_permission` is never answered, the agent's prompt turn stops
 * dead and nothing in the log explains why.
 */
export function PendingPanel({ pending, send }: PendingPanelProps) {
  if (pending.length === 0) return null;

  return (
    <section className="pending">
      {pending.map((request) => (
        <article key={String(request.id)} className="pending-item">
          <header>
            <code>{request.method}</code>
            <span className="muted">id {String(request.id)}</span>
            <span className="muted">
              waiting {Math.round((Date.now() - request.receivedAt) / 1000)}s
            </span>
          </header>

          {request.method === 'session/request_permission' ? (
            <PermissionAnswers request={request} send={send} />
          ) : (
            <GenericAnswers request={request} send={send} />
          )}

          <details>
            <summary>params</summary>
            <pre className="payload small">{JSON.stringify(request.params, null, 2)}</pre>
          </details>
        </article>
      ))}
    </section>
  );
}

function PermissionAnswers({
  request,
  send,
}: {
  request: PendingRequest;
  send: (command: ClientCommand) => void;
}) {
  const params = (request.params ?? {}) as { options?: PermissionOption[]; toolCall?: unknown };
  const options = Array.isArray(params.options) ? params.options : [];
  const title = (params.toolCall as { title?: string } | undefined)?.title;

  return (
    <div className="answers">
      {title && <p className="tool-title">{title}</p>}
      {options.length === 0 && (
        <p className="warn">
          The agent sent no options. Any answer other than <code>cancelled</code> would be invented.
        </p>
      )}
      {options.map((option) => (
        <button
          type="button"
          key={option.optionId ?? option.name}
          className={option.kind?.startsWith('allow') ? 'primary' : ''}
          onClick={() =>
            send({
              type: 'respond',
              id: request.id,
              result: { outcome: { outcome: 'selected', optionId: option.optionId } },
            })
          }
        >
          {option.name ?? option.optionId} <span className="muted">({option.kind ?? '?'})</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          send({ type: 'respond', id: request.id, result: { outcome: { outcome: 'cancelled' } } })
        }
      >
        cancelled
      </button>
      <button
        type="button"
        className="danger"
        title="Answer with a JSON-RPC error rather than an outcome, to see how the agent copes"
        onClick={() =>
          send({
            type: 'respond',
            id: request.id,
            error: { code: -32603, message: 'inspector refused the permission request' },
          })
        }
      >
        reply with error
      </button>
    </div>
  );
}

function GenericAnswers({
  request,
  send,
}: {
  request: PendingRequest;
  send: (command: ClientCommand) => void;
}) {
  return (
    <div className="answers">
      {request.method === 'elicitation/create' && (
        <>
          <button
            type="button"
            onClick={() =>
              send({ type: 'respond', id: request.id, result: { action: 'decline' } })
            }
          >
            decline
          </button>
          <button
            type="button"
            onClick={() => send({ type: 'respond', id: request.id, result: { action: 'cancel' } })}
          >
            cancel
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => send({ type: 'respond', id: request.id, result: {} })}
      >
        empty result
      </button>
      <button
        type="button"
        className="danger"
        onClick={() =>
          send({
            type: 'respond',
            id: request.id,
            error: { code: -32601, message: `inspector does not handle ${request.method}` },
          })
        }
      >
        reply with error
      </button>
    </div>
  );
}
