interface Props {
  id:       string
  title:    string
  subtitle: string
}

export function SectionDivider({ id, title, subtitle }: Props) {
  return (
    <div id={id} className="scroll-mt-24 mt-6 mx-12 border-t-2 border-[#1A1A1A] pt-4 pb-2">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[20px] font-bold text-[#1A1A1A] tracking-[-0.5px]">{title}</h2>
        <span className="font-mono text-[11px] text-[#888888] tracking-[0.5px]">{subtitle}</span>
      </div>
    </div>
  )
}
