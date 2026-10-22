import { describe, it, expect } from 'vitest'
import { githubIssuePath, parseGithubIssue } from './github'
describe('GitHub task preview',()=>{
  it('only accepts specific public GitHub issue and PR paths, never arbitrary hosts or commands',()=>{
    expect(githubIssuePath('https://github.com/acme/app/issues/42#comment').apiPath).toBe('repos/acme/app/issues/42')
    expect(githubIssuePath('https://github.com/acme/app/pull/42?view=1').apiPath).toBe('repos/acme/app/issues/42')
    for(const url of ['https://evil.com/acme/app/issues/1','https://github.com.evil.com/acme/app/issues/1','https://user@github.com/acme/app/issues/1','https://github.com/acme/app/issues/1/comments','http://github.com/acme/app/issues/1','https://github.com/acme/app/issues/-1']) expect(()=>githubIssuePath(url)).toThrow()
  })
  it('validates issue identity and reports truncation without creating a task',()=>{
    const url='https://github.com/acme/app/issues/42';const raw=JSON.stringify({title:'Repair login',body:'x'.repeat(50_001),html_url:url,number:42})
    const preview=parseGithubIssue(raw,url)
    expect(preview.externalId).toBe('repos/acme/app/issues/42');expect(preview.description).toHaveLength(50_000);expect(preview.truncated).toBe(true)
    expect(()=>parseGithubIssue(raw,'https://github.com/acme/app/issues/43')).toThrow('different issue')
    expect(()=>parseGithubIssue('{}',url)).toThrow('invalid issue')
  })
})
