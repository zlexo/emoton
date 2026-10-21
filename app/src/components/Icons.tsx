type P = { size?: number };
const S = ({ size = 15, children, sw = 1.8 }: P & { children: React.ReactNode; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
export const IGrid = (p: P) => <S {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></S>;
export const IClock = (p: P) => <S {...p}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></S>;
export const IFolder = (p: P) => <S {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></S>;
export const IPlus = (p: P) => <S {...p} sw={2.4}><path d="M12 5v14M5 12h14" /></S>;
export const ISearch = (p: P) => <S {...p} sw={2}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></S>;
export const IChevron = (p: P & { open?: boolean }) => <span style={{ display: "inline-flex", transform: p.open ? "rotate(90deg)" : "none", transition: "transform .12s" }}><S size={p.size ?? 11} sw={2.4}><path d="m9 6 6 6-6 6" /></S></span>;
export const IDown = (p: P) => <S size={p.size ?? 10} sw={2.4}><path d="m6 9 6 6 6-6" /></S>;
export const IDots = (p: P) => <S {...p} sw={2.6}><path d="M5 12h.01M12 12h.01M19 12h.01" /></S>;
export const IPlay = (p: P) => <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z" /></svg>;
export const IPause = (p: P) => <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>;
export const IChat = (p: P) => <S {...p} sw={2}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></S>;
export const IX = (p: P) => <S size={p.size ?? 12} sw={2.4}><path d="M6 6l12 12M18 6 6 18" /></S>;
export const IDoc = (p: P) => <S {...p}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></S>;
export const ILink = (p: P) => <S {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></S>;
export const ISpeaker = (p: P) => <S {...p}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M16 9a4 4 0 0 1 0 6" /></S>;
export const IGear = (p: P) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></S>;
