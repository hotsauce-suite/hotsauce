import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../test/renderApp'
import { holdListPlace, listItems, moveInList } from './listKeys'

describe('list keys in Files and Meetings (slice 5)', () => {
  it('u opens the upload picker in Files, and j moves to the first row', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const input = (await screen.findByTestId('files-input')) as HTMLInputElement
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    await user.keyboard('u')
    expect(click).toHaveBeenCalled()
    await waitFor(() =>
      expect(document.querySelectorAll('[data-list-item]').length).toBeGreaterThan(0),
    )
    await user.keyboard('j')
    expect(document.activeElement).toBe(document.querySelector('[data-list-item]'))
  })

  it('j moves through the meeting list', async () => {
    const user = userEvent.setup()
    renderApp('/meetings')
    const items = await screen.findAllByTestId('meeting-item')
    await user.keyboard('j')
    expect(items[0]).toHaveFocus()
    if (items.length > 1) {
      await user.keyboard('j')
      expect(items[1]).toHaveFocus()
    }
  })

  it('shows the list keys on the ? sheet where a list is', async () => {
    const user = userEvent.setup()
    renderApp('/people')
    await screen.findAllByTestId('people-row')
    await user.keyboard('?')
    const sheet = await screen.findByTestId('shortcuts-sheet')
    expect(sheet).toHaveTextContent('Next item')
  })
})

describe('reading order and rows (L1, L2)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('a board drawn column by column is read along its rows', () => {
    // Three columns, notes dealt 0 1 2 / 3 4 5: the page holds column 0 (0, 3), then 1, then 2.
    document.body.innerHTML = `
      <button data-list-item id="before">before</button>
      <div data-list-group>
        <div><button data-list-item data-list-order="0">n0</button><button data-list-item data-list-order="3">n3</button></div>
        <div><button data-list-item data-list-order="1">n1</button><button data-list-item data-list-order="4">n4</button></div>
        <div><button data-list-item data-list-order="2">n2</button></div>
      </div>
      <div data-list-group>
        <div><button data-list-item data-list-order="0">m0</button></div>
        <div><button data-list-item data-list-order="1">m1</button></div>
      </div>`
    expect(listItems().map((el) => el.textContent)).toEqual([
      'before',
      'n0',
      'n1',
      'n2',
      'n3',
      'n4',
      'm0',
      'm1',
    ])
  })

  it('j from a control beside the row’s main button goes to the next row', () => {
    document.body.innerHTML = `
      <article data-list-row><button data-list-item>one</button><button id="pin">pin</button></article>
      <article data-list-row><button data-list-item id="two">two</button></article>`
    document.getElementById('pin')?.focus()
    moveInList(1)
    expect(document.activeElement?.id).toBe('two')
  })

  it('a row key pressed from a control beside the item keeps the place when the row goes', async () => {
    document.body.innerHTML = `
      <ul>
        <li data-list-row id="a"><a href="#a" data-list-item>a</a><button id="done">Done</button></li>
        <li data-list-row><a href="#b" data-list-item id="b">b</a></li>
      </ul>`
    document.getElementById('done')?.focus()
    holdListPlace()
    document.getElementById('a')?.remove()
    await waitFor(() => expect(document.activeElement?.id).toBe('b'))
  })
})
