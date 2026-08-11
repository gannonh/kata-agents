import { describe, expect, test } from 'bun:test'
import {
  describeFirstDifference,
  isPlatformPackageName,
  mergePythonRecords,
  normalizeLineEndings,
  parsePythonDependencies,
} from '../generate-third-party-notices'

const imgTool = `# /// script
# requires-python = ">=3.12"
# dependencies = ["Pillow>=12.1,<13", "click>=8.3,<9"]
# ///`

const pdfTool = `# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "pypdfium2>=5.5,<6",
#   "pypdf>=6.7,<7",
#   "img2pdf>=0.5,<1",
#   "Pillow>=10,<12",
#   "click>=8.3,<9",
#   "python-pptx>=1.0,<2",
#   "python-docx>=1.1,<2",
# ]
# ///`

describe('generate-third-party-notices Python collection', () => {
  test('parses PEP 723 dependency declarations from a script header', () => {
    const dependencies = parsePythonDependencies(pdfTool)
    expect(dependencies).toContainEqual({ name: 'Pillow', constraint: '>=10,<12' })
    expect(dependencies).toContainEqual({ name: 'click', constraint: '>=8.3,<9' })
  })

  test('preserves conflicting constraints for a package shared by tools', () => {
    // img_tool.py requires Pillow>=12.1,<13 while pdf_tool.py declares
    // Pillow>=10,<12. The inventory must keep both declarations instead of
    // letting whichever file sorts last silently drop the other.
    const records = mergePythonRecords([
      { name: 'img_tool.py', text: imgTool },
      { name: 'pdf_tool.py', text: pdfTool },
    ])
    const pillow = records.find((record) => record.name === 'Pillow')
    expect(pillow?.constraints).toEqual(['>=10,<12', '>=12.1,<13'])
  })

  test('does not let file discovery order decide the merged constraints', () => {
    const forward = mergePythonRecords([
      { name: 'img_tool.py', text: imgTool },
      { name: 'pdf_tool.py', text: pdfTool },
    ])
    const backward = mergePythonRecords([
      { name: 'pdf_tool.py', text: pdfTool },
      { name: 'img_tool.py', text: imgTool },
    ])
    expect(forward).toEqual(backward)
  })

  test('deduplicates identical constraints declared by multiple tools', () => {
    const records = mergePythonRecords([
      { name: 'a_tool.py', text: imgTool },
      { name: 'b_tool.py', text: imgTool },
    ])
    const click = records.find((record) => record.name === 'click')
    expect(click?.constraints).toEqual(['>=8.3,<9'])
  })

  test('skips packages without license metadata', () => {
    const records = mergePythonRecords([
      {
        name: 'unknown_tool.py',
        text: `# /// script\n# dependencies = ["NotAListedPackage>=1,<2"]\n# ///`,
      },
    ])
    expect(records).toEqual([])
  })
})

describe('generate-third-party-notices platform filtering', () => {
  test('recognizes only the OS-specific exiftool binary package variants', () => {
    expect(isPlatformPackageName('exiftool-vendored.exe')).toBe(true)
    expect(isPlatformPackageName('exiftool-vendored.pl')).toBe(true)
    expect(isPlatformPackageName('exiftool-vendored.docs')).toBe(false)
    expect(isPlatformPackageName('exiftool-vendored.helper')).toBe(false)
  })
})

describe('generate-third-party-notices staleness check', () => {
  // Guard the latent case where a Windows checkout rewrites a pure-LF notice
  // file to CRLF even though the repository content matches.
  test('treats a CRLF checkout of identical content as up to date', () => {
    const generated = '# Third-Party Notices\n\n| a | b |\n'
    const windowsCheckout = generated.replaceAll('\n', '\r\n')
    expect(windowsCheckout).not.toBe(generated)
    expect(normalizeLineEndings(windowsCheckout)).toBe(normalizeLineEndings(generated))
  })

  test('still detects real content drift', () => {
    const generated = '# Third-Party Notices\n\n| pkg | 1.0.0 |\n'
    const committed = '# Third-Party Notices\n\n| pkg | 0.9.0 |\n'
    expect(normalizeLineEndings(committed)).not.toBe(normalizeLineEndings(generated))
  })

  test('reports the first real differing line across line-ending styles', () => {
    const message = describeFirstDifference(
      '# Notices\n| stable | 1.0.0 |\n| pkg | 1.0.0 |\n',
      '# Notices\r\n| stable | 1.0.0 |\r\n| pkg | 0.9.0 |\r\n',
    )
    expect(message).toContain('First difference at line 3:')
    expect(message).toContain('1.0.0')
    expect(message).toContain('0.9.0')
  })

  test('names the end of file when the committed copy is truncated', () => {
    const message = describeFirstDifference('a\nb', 'a')
    expect(message).toContain('<end of file>')
  })
})
