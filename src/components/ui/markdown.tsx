import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/**
 * Renders agent output as Markdown with Backstory-toned typography. No raw
 * <pre> dumps — headings, lists, tables, code and links all render properly.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('space-y-3 text-sm leading-6 text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 className="text-base font-semibold" {...props} />,
          h2: (props) => <h2 className="text-base font-semibold" {...props} />,
          h3: (props) => <h3 className="text-sm font-semibold" {...props} />,
          p: (props) => <p className="whitespace-pre-wrap" {...props} />,
          ul: (props) => <ul className="list-disc space-y-1 pl-5" {...props} />,
          ol: (props) => <ol className="list-decimal space-y-1 pl-5" {...props} />,
          li: (props) => <li className="pl-0.5" {...props} />,
          a: (props) => <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
          code: (props) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...props} />,
          pre: (props) => <pre className="overflow-x-auto rounded-lg border bg-muted p-3 text-xs" {...props} />,
          table: (props) => <table className="w-full border-collapse text-xs" {...props} />,
          th: (props) => <th className="border px-2 py-1 text-left font-semibold" {...props} />,
          td: (props) => <td className="border px-2 py-1 align-top" {...props} />,
          blockquote: (props) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
