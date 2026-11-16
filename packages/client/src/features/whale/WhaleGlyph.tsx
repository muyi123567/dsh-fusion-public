import { useId } from "react";

export function WhaleGlyph({ className = "", size = 112 }: { className?: string; size?: number }) {
  const gradient = useId().replaceAll(":", "");
  return <svg className={className} width={size} height={size * .58} viewBox="0 0 160 92" fill="none" aria-hidden="true">
    <defs><linearGradient id={gradient} x1="16" y1="20" x2="124" y2="85" gradientUnits="userSpaceOnUse"><stop stopColor="currentColor" stopOpacity=".94"/><stop offset="1" stopColor="currentColor" stopOpacity=".28"/></linearGradient></defs>
    <path d="M119 42C111 30 94 23 69 24C40 25 17 38 15 53C12 72 44 83 76 76C94 72 108 62 119 55C124 57 130 61 133 66C140 62 142 52 140 45C149 39 152 31 148 22C141 23 134 30 132 38C127 31 121 28 115 29C113 34 115 39 119 42Z" fill={`url(#${gradient})`}/>
    <path d="M23 58C46 72 79 70 106 53M27 62C49 76 80 70 101 58M31 67C54 79 76 74 94 63" stroke="currentColor" strokeOpacity=".28" strokeWidth="1"/>
    <path d="M68 59C62 66 66 80 78 84C86 78 84 69 77 61" fill="currentColor" fillOpacity=".5"/>
    <circle cx="34" cy="48" r="2.1" fill="#071824"/><path d="M17 56C25 59 33 60 39 58" stroke="#071824" strokeOpacity=".6" strokeLinecap="round"/>
  </svg>;
}
