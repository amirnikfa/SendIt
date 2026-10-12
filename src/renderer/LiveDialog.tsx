import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Cable,
  Copy,
  Eraser,
  Send,
  Square,
} from 'lucide-react';
import { type LiveEvent, newRequest, uid } from '../shared/models';
import { Modal, copyText } from './components';
import { requestContext, useStore } from './store';
import './live.css';

export function LiveDialog({ onClose }: { onClose: () => void }) {
  const id = useRef(uid()).current;
  const [protocol, setProtocol] = useState<'websocket' | 'sse'>('websocket');
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<'offline' | 'connecting' | 'connected'>('offline');
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [message, setMessage] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const notify = useStore((s) => s.notify);
  useEffect(() => {
    const unsubscribe = window.workbench.onLive((event) => {
      if (event.id !== id) return;
      setEvents((list) => [...list.slice(-199), event]);
      if (event.type === 'open') setPhase('connected');
      if (event.type === 'close' || event.type === 'error') setPhase('offline');
    });
    return () => {
      unsubscribe();
      void window.workbench.liveDisconnect(id);
    };
  }, [id]);
  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight });
  }, [events]);
  const connect = async () => {
    if (phase !== 'offline') {
      await window.workbench.liveDisconnect(id);
      setPhase('offline');
      return;
    }
    const data = useStore.getState().data;
    const active = data.tabs.find((t) => t.id === data.activeTabId);
    const request = structuredClone(active?.request || newRequest());
    request.url = url;
    request.params = [];
    request.method = 'GET';
    setPhase('connecting');
    try {
      await window.workbench.liveConnect(
        id,
        protocol,
        requestContext(data, request, active?.workspaceId),
      );
    } catch (error) {
      setPhase('offline');
      notify(String(error), 'error');
    }
  };
  const send = async () => {
    try {
      await window.workbench.liveSend(id, message);
      setMessage('');
    } catch (error) {
      notify(String(error), 'error');
    }
  };
  return (
    <Modal
      title="Live connections"
      subtitle="Inspect WebSocket messages and server-sent events in real time."
      onClose={onClose}
      width={960}
    >
      <div className="live-tool">
        <div className="live-address">
          <select
            aria-label="Live protocol"
            disabled={phase !== 'offline'}
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as 'websocket' | 'sse')}
          >
            <option value="websocket">WebSocket</option>
            <option value="sse">Server-Sent Events</option>
          </select>
          <input
            aria-label="Live URL"
            placeholder={
              protocol === 'websocket'
                ? 'wss://your-api.example/socket'
                : 'https://your-api.example/events'
            }
            value={url}
            disabled={phase !== 'offline'}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void connect();
            }}
          />
          <button className="button primary" disabled={!url.trim()} onClick={() => void connect()}>
            {phase === 'offline' ? (
              <>
                <Cable size={14} />
                Connect
              </>
            ) : (
              <>
                <Square size={12} />
                Disconnect
              </>
            )}
          </button>
        </div>
        <p className="help">
          Uses the current request’s headers, authentication, variables, and network settings.
          Scripts and the HTTP cookie jar are separate from live connections. Closing this panel
          disconnects.
        </p>
        <div className="live-feed-toolbar">
          <span className={`live-state ${phase}`}>
            <Activity size={13} />
            {phase === 'offline'
              ? 'Disconnected'
              : phase === 'connecting'
                ? 'Connecting…'
                : 'Connected'}
          </span>
          <span className="muted">{events.length} events</span>
          <div className="spacer" />
          <button
            className="text-button"
            disabled={!events.length}
            onClick={() =>
              void copyText(events.map((e) => `${e.at} ${e.type}\n${e.data}`).join('\n\n'))
            }
          >
            <Copy size={13} />
            Copy log
          </button>
          <button className="text-button" onClick={() => setEvents([])}>
            <Eraser size={13} />
            Clear
          </button>
        </div>
        <div className="live-feed" ref={feed} aria-label="Connection events">
          {!events.length && (
            <div className="live-empty">
              <Cable size={32} />
              <strong>Your next conversation starts here</strong>
              <p>Connect to a server to inspect incoming messages.</p>
            </div>
          )}
          {events.map((event, i) => (
            <div className={`live-event ${event.type}`} key={`${event.at}-${i}`}>
              <div>
                {event.type === 'sent' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                <strong>{event.type}</strong>
                <time>{new Date(event.at).toLocaleTimeString()}</time>
              </div>
              <pre>{event.data}</pre>
            </div>
          ))}
        </div>
        {protocol === 'websocket' && (
          <div className="live-composer">
            <textarea
              aria-label="WebSocket message"
              placeholder="Write a text or JSON message…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.ctrlKey && e.key === 'Enter') void send();
              }}
            />
            <button
              className="button primary"
              disabled={phase !== 'connected' || !message}
              onClick={() => void send()}
            >
              <Send size={14} />
              Send message
            </button>
          </div>
        )}
        <p className="help">
          Keeps the latest 200 events. Messages are limited to 1 MB. Reconnection is manual.
        </p>
      </div>
    </Modal>
  );
}
