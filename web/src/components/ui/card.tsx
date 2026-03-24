interface CardProps {
  children: React.ReactNode
  className?: string
  title?: string
  titleAction?: React.ReactNode
}

export function Card({ children, className = '', title, titleAction }: CardProps) {
  return (
    <div className={`bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] overflow-hidden ${className}`}>
      {(title || titleAction) && (
        <div className="px-6 py-4 border-b border-[#E5E4E1] flex items-center justify-between">
          {title && <h2 className="text-sm font-semibold text-[#1A1918] tracking-wide">{title}</h2>}
          {titleAction && <div className="flex items-center gap-2">{titleAction}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
