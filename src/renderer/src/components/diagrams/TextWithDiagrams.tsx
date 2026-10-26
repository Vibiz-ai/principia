/**
 * Plain-text surfaces (agent answers, task briefs, forum posts): the text as that surface draws it, with every
 * ```principia-graph block swapped for the drawn diagram. Text without a block renders exactly as before.
 */
import { Fragment, useMemo } from 'react'
import { hasDiagram, splitDiagrams } from '@shared/diagram'
import { DiagramBlock } from './DiagramBlock'

export function TextWithDiagrams({ text, renderText }: { text: string; renderText: (text: string, i: number) => React.ReactNode }): React.JSX.Element {
  const segs = useMemo(() => (hasDiagram(text) ? splitDiagrams(text) : null), [text])
  if (!segs) return <>{renderText(text, 0)}</>
  return (
    <>
      {segs.map((s, i) => (s.t === 'text' ? <Fragment key={i}>{renderText(s.v, i)}</Fragment> : <DiagramBlock key={i} source={s.raw} />))}
    </>
  )
}
