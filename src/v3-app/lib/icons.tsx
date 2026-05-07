// Inline SVG icon set lifted from src/v3/primitives.jsx Icon namespace.
// Kept as static JSX nodes so callers reference them as `Icon.bolt` rather
// than constructing components on every render.
//
// The base wrapper is exported as `I` for one-off custom paths in callers.

import React, { CSSProperties, ReactNode } from "react";

export interface IProps {
  d: ReactNode;
  size?: number;
  sw?: number;
  fill?: string;
  style?: CSSProperties;
}

export const I: React.FC<IProps> = ({ d, size = 14, sw = 1.5, fill = "none", style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
    {d}
  </svg>
);

export const Icon = {
  search:   <I d={<><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>} />,
  bolt:     <I d={<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>} />,
  inbox:    <I d={<><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/></>} />,
  layers:   <I d={<><path d="m12 2 10 6-10 6L2 8l10-6Z"/><path d="m2 16 10 6 10-6"/><path d="m2 12 10 6 10-6"/></>} />,
  doc:      <I d={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></>} />,
  user:     <I d={<><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>} />,
  users:    <I d={<><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><circle cx="17" cy="6" r="3"/><path d="M22 19a5 5 0 0 0-5-5"/></>} />,
  truck:    <I d={<><path d="M14 18V6h2l4 5v7h-2"/><path d="M14 18H3V6h11"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></>} />,
  pkg:      <I d={<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></>} />,
  graph:    <I d={<><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M8 7l3 9"/><path d="M16 7l-3 9"/></>} />,
  shield:   <I d={<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>} />,
  settings: <I d={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></>} />,
  briefcase:<I d={<><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></>} />,
  wrench:   <I d={<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>} />,
  cash:     <I d={<><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></>} />,
  sigma:    <I d={<path d="M18 7V4H6l6 8-6 8h12v-3"/>} />,
  cycle:    <I d={<><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>} />,
  flag:     <I d={<><path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/></>} />,
  arrowR:   <I d={<><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></>} />,
  arrowL:   <I d={<><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></>} />,
  arrowD:   <I d={<><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></>} />,
  arrowU:   <I d={<><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></>} />,
  plus:     <I d={<><path d="M12 5v14"/><path d="M5 12h14"/></>} />,
  x:        <I d={<><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>} />,
  close:    <I d={<><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>} />,
  check:    <I d={<path d="m20 6-11 11-5-5"/>} />,
  alert:    <I d={<><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></>} />,
  info:     <I d={<><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></>} />,
  more:     <I d={<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>} />,
  filter:   <I d={<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z"/>} />,
  download: <I d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></>} />,
  upload:   <I d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></>} />,
  // Audit P13.B.3.3. Camera icon for the mobile-capture button on
  // the SO intake screen. Renders a generic point-and-shoot
  // outline + a centred lens circle.
  camera:   <I d={<><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="4"/></>} />,
  send:     <I d={<><path d="m22 2-7 20-4-9-9-4Z"/><path d="m22 2-11 11"/></>} />,
  link:     <I d={<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72"/></>} />,
  bell:     <I d={<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></>} />,
  filterX:  <I d={<><path d="M13 13H4l8 9v-7"/><path d="m22 3-9 10"/><path d="M2 3h20"/></>} />,
  zap:      <I d={<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>} />,
  history:  <I d={<><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></>} />,
  lock:     <I d={<><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>} />,
  logout:   <I d={<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></>} />,
  eye:      <I d={<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></>} />,
  star:     <I d={<polygon points="12,2 15,9 22,9 16,14 19,22 12,17 5,22 8,14 2,9 9,9"/>} />,
  ext:      <I d={<><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></>} />,
  cal:      <I d={<><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>} />,
  tag:      <I d={<><path d="M20.59 13.41 12 22l-9-9V3h10l8.59 8.59a2 2 0 0 1 0 2.83Z"/><circle cx="7.5" cy="7.5" r="1"/></>} />,
  flame:    <I d={<><path d="M14 4s5 5 5 10a7 7 0 0 1-14 0c0-3 2-5 2-7s2-3 4-3"/></>} />,
  brain:    <I d={<><path d="M9 4a3 3 0 0 0-3 3v0a3 3 0 0 0-3 3v0a3 3 0 0 0 0 6v0a3 3 0 0 0 3 3v0a3 3 0 0 0 3 3"/><path d="M15 4a3 3 0 0 1 3 3v0a3 3 0 0 1 3 3v0a3 3 0 0 1 0 6v0a3 3 0 0 1-3 3v0a3 3 0 0 1-3 3"/><path d="M9 4v18M15 4v18"/></>} />,
  caret:    <I d={<path d="m6 9 6 6 6-6"/>} />,
  caretR:   <I d={<path d="m9 6 6 6-6 6"/>} />,
  globe:    <I d={<><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></>} />,
  shieldCheck: <I d={<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>} />,
  ledger:   <I d={<><path d="M3 5a2 2 0 0 1 2-2h12a4 4 0 0 1 4 4v14a2 2 0 0 0-2-2H7a4 4 0 0 0-4 4V5Z"/><path d="M8 7h6M8 11h6"/></>} />,
  signal:   <I d={<><path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/><path d="M22 4v16"/></>} />,
  diff:     <I d={<><path d="M12 3v18"/><path d="m18 9-6-6-6 6"/><path d="m6 15 6 6 6-6"/></>} />,
  edit:     <I d={<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/></>} />,
  trash:    <I d={<><path d="M3 6h18"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></>} />,
};
