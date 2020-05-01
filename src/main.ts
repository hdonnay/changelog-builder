import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as fs from 'fs'

async function run(): Promise<void> {
  try {
    // Grab the nice name
    let tag = ''
    await exec.exec('git', ['describe', '--exact-match', 'HEAD'], {
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
        listeners: {
          stdline: (l: string) => {
            prev = l
          }
        }
      }
    )
    const tagmsg: string[] = []
    const tagmsgDone = exec.exec(
      'git',
      ['for-each-ref', '--format=%(contents:body)', `refs/tags/${tag}`],
      {
        listeners: {
          stdline: (l: string) => {
            tagmsg.push(l)
          }
        }
      }
    )
    let subject = ''
    const subjectDone = exec.exec(
      'git',
      ['for-each-ref', '--format=%(contents:subject)', `refs/tags/${tag}`],
      {
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
          outStream: f
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
          let capture = ''
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
                      listeners: {
                        stdline: (l: string) => {
                          capture += l
                        }
                      }
                    }
                  )
                  changes.update.push(capture)
                  break
                case 'new':
                  await exec.exec(
                    'git',
                    ['show', '--quiet', '--format=%s', commit],
                    {
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
    buf += '\n'

    await tagmsgDone
    if (tagmsg.length !== 0) {
      buf += tagmsg.join('\n')
      buf += '\n'
    }

    for (const msg of changes.update) {
      buf += msg
      buf += '\n'
    }
    if (changes.fix.length !== 0) {
      buf += '## Bugfixes\n\n'
      for (const item of changes.fix) {
        buf += ` * ${item}`
        buf += '\n'
      }
      buf += '\n'
    }
    if (changes.new.length !== 0) {
      buf += '## Additions\n\n'
      for (const item of changes.new) {
        buf += ` * ${item}`
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
    listeners: {
      stdline: (l: string) => {
        commits.push(l)
      }
    }
  })
  return commits
}

run()
