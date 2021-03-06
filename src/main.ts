import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as fs from 'fs'

async function run(): Promise<void> {
  try {
    // Grab the nice name
    let tag = ''
    await exec.exec('git', ['describe', '--exact-match', 'HEAD'], {
      silent: true,
      listeners: {
        stdline: (l: string) => {
          tag = l
        }
      }
    })
    // grab previous tag
    let prev = ''
    await exec.exec(
      'git',
      [
        'describe',
        '--tags',
        '--abbrev=0',
        '--exclude=*alpha*',
        '--exclude=*beta*',
        '--exclude=*rc*',
        'HEAD^'
      ],
      {
        silent: true,
        listeners: {
          stdline: (l: string) => {
            prev = l
          }
        }
      }
    )
    core.debug(`examing commits between '${prev}' and '${tag}'`)
    const tagmsg: Buffer[] = []
    const tagmsgDone = exec.exec(
      'git',
      ['for-each-ref', '--format=%(contents:body)', `refs/tags/${tag}`],
      {
        silent: true,
        listeners: {
          stdout: (data: Buffer) => {
            tagmsg.push(data)
          }
        }
      }
    )
    let subject = ''
    const subjectDone = exec.exec(
      'git',
      ['for-each-ref', '--format=%(contents:subject)', `refs/tags/${tag}`],
      {
        silent: true,
        listeners: {
          stdline: (l: string) => {
            subject = l
          }
        }
      }
    )

    interface Changelog {
      update: string[]
      new: string[]
      fix: string[]
    }
    const changes: Changelog = {
      update: [],
      new: [],
      fix: []
    }

    for (const commit of await commitsSince(prev)) {
      const name = `${commit}.body`
      try {
        const f = fs.createWriteStream(name)
        await exec.exec('git', ['show', '--quiet', '--format=%b', commit], {
          silent: true,
          listeners: {
            stdout: (b: Buffer) => {
              f.write(b)
            }
          }
        })
        const trailers: string[] = []
        await exec.exec('git', ['interpret-trailers', '--parse', name], {
          silent: true,
          listeners: {
            stdline: (l: string) => {
              trailers.push(l)
            }
          }
        })
        if (trailers.length === 0) {
          core.debug(`${commit}: found no trailers`)
        }
        for (const line of trailers) {
          const kv = line.split(': ')
          const capture: Buffer[] = []
          switch (kv[0]) {
            case 'Changelog':
              switch (kv[1].toLowerCase()) {
                case 'update':
                  await exec.exec(
                    'git',
                    [
                      'interpret-trailers',
                      '--unfold',
                      '--if-exists=replace',
                      '--trailer=*',
                      '--trim-empty',
                      name
                    ],
                    {
                      silent: true,
                      listeners: {
                        stdout: (data: Buffer) => {
                          capture.push(Buffer.from(data))
                        }
                      }
                    }
                  )
                  changes.update.push(Buffer.concat(capture).toString())
                  break
                case 'new':
                  await exec.exec(
                    'git',
                    ['show', '--quiet', '--format=%s', commit],
                    {
                      silent: true,
                      listeners: {
                        stdline: (l: string) => {
                          changes.new.push(l)
                        }
                      }
                    }
                  )
                  break
                case 'fix':
                  await exec.exec(
                    'git',
                    ['show', '--quiet', '--format=%s', commit],
                    {
                      silent: true,
                      listeners: {
                        stdline: (l: string) => {
                          changes.fix.push(l)
                        }
                      }
                    }
                  )
                  break
              }
              break
            /* Could add additional trailers, like:
            case 'Fix':
            case 'Fixes':
              break
			 */
            default:
              core.debug(`${commit}: found no interesting trailers`)
            // skip
          }
        }
      } finally {
        await io.rmRF(name)
      }
    }
    let buf = `# ${tag} Changelog`
    buf += '\n\n'

    await tagmsgDone
    if (tagmsg.length !== 0) {
      buf += Buffer.concat(tagmsg)
        .toString()
        .trim()
      buf += '\n'
    }

    for (const msg of changes.update) {
      buf += msg.trim()
      buf += '\n'
    }
    if (changes.update.length !== 0) {
      buf += '\n'
    }
    if (changes.fix.length !== 0) {
      buf += '## Bugfixes\n\n'
      for (const item of changes.fix) {
        buf += ` * ${item.trim()}`
        buf += '\n'
      }
      buf += '\n'
    }
    if (changes.new.length !== 0) {
      buf += '## Additions\n\n'
      for (const item of changes.new) {
        buf += ` * ${item.trim()}`
        buf += '\n'
      }
      buf += '\n'
    }

    if (
      changes.update.length === 0 &&
      changes.fix.length === 0 &&
      changes.new.length === 0
    ) {
      buf += 'This was an uneventful development cycle.\n'
    }

    core.setOutput('changes', buf)
    await subjectDone
    core.setOutput('subject', subject)
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function commitsSince(commitish: string): Promise<string[]> {
  const commits: string[] = []
  await exec.exec('git', ['log', '--format=tformat:%H', `${commitish}...`], {
    silent: true,
    listeners: {
      stdline: (l: string) => {
        commits.push(l)
      }
    }
  })
  return commits
}

run()
