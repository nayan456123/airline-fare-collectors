import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { confirmBookingForm, confirmSelectedAirport, selectAirport, selectDate, selectOneWay } from '../src/collect.mjs';

const executablePath = process.env.AIRINDIA_TEST_CHROME_PATH;

test('selects One Way through native or visible-label UI and rejects an unconfirmed click in Chromium', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium form test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const nonLocalRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else {
        nonLocalRequests.push(url.href);
        await route.abort();
      }
    });

    await page.setContent(`<label>One Way
        <input id="one-way" type="radio" name="journey" value="one-way" style="display:none">
      </label>
      <label>Round Trip<input id="round-trip" type="radio" name="journey" value="round-trip" checked></label>`);
    await selectOneWay(page);
    assert.equal(await page.locator('input[value="one-way"]').isChecked(), true,
      'clicking the visible label should select its hidden native radio');
    assert.equal(await page.locator('input[value="round-trip"]').isChecked(), false);

    await page.setContent(`<label for="one-way">One Way</label>
      <input id="one-way" type="radio" name="journey" value="one-way">
      <label for="round-trip">Round Trip</label>
      <input id="round-trip" type="radio" name="journey" value="round-trip" checked>`);
    await selectOneWay(page);
    assert.equal(await page.locator('input[value="one-way"]').isChecked(), true,
      'the visible native radio layout should still work');

    await page.setContent(`<label id="one-way-label">One Way
        <input type="radio" name="journey" value="one-way" style="display:none">
      </label>
      <label>Round Trip<input type="radio" name="journey" value="round-trip" checked></label>
      <script>document.querySelector('#one-way-label').addEventListener('click', event => event.preventDefault())</script>`);
    await assert.rejects(selectOneWay(page), error => error.code === 'FORM_UNCONFIRMED');
    assert.equal(await page.locator('input[value="one-way"]').isChecked(), false,
      'a click that does not select the radio must fail instead of forcing form state');
    assert.deepEqual(nonLocalRequests, [], 'all fixture interaction must remain local');
  } finally {
    await browser.close();
  }
});

test('dismisses the navigation menu and centers the hidden-radio booking target before clicking', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium form test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const externalRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else { externalRequests.push(url.href); await route.abort(); }
    });
    await page.setContent(`<style>
      body{margin:0} #menu{position:fixed;inset:0;background:#123;color:white;z-index:99}
      #spacer{height:1500px} #one-way-label{display:inline-block;padding:20px}
      #one-way{display:none}
    </style>
    <nav id="menu">Open navigation menu</nav><div id="spacer"></div>
    <main class="ai-booking-widget--desktop ai-booking-widget--homepage">
      <label id="one-way-label">One Way<input id="one-way" type="radio" name="journey" value="one-way"></label>
    </main>
    <div style="height:900px"></div>
    <script>
      let escaped=false, movedAway=false;
      const menu=document.querySelector('#menu');
      const closeWhenReady=()=>{if(escaped&&movedAway)menu.style.display='none'};
      window.addEventListener('keydown',event=>{if(event.key==='Escape'){escaped=true;closeWhenReady()}});
      window.addEventListener('pointermove',event=>{
        if(event.clientX>innerWidth-20&&event.clientY>innerHeight-20){movedAway=true;closeWhenReady()}
      });
    </script>`);

    await selectOneWay(page);
    assert.equal(await page.locator('#one-way').isChecked(), true,
      'the normal label click should select the one-way radio');
    const after = await page.evaluate(() => {
      const rect=document.querySelector('#one-way-label').getBoundingClientRect();
      return { menuDisplay:getComputedStyle(document.querySelector('#menu')).display,
        centerY:rect.top+rect.height/2, viewportCenter:innerHeight/2 };
    });
    assert.equal(after.menuDisplay, 'none', 'the ordinary navigation overlay should close');
    assert.ok(Math.abs(after.centerY-after.viewportCenter)<20,
      `the booking target should be centered (got ${after.centerY}, expected ${after.viewportCenter})`);
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser.close();
  }
});

test('selects exact airports through observed autocomplete options and rejects route mismatch in Chromium', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium form test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const nonLocalRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else {
        nonLocalRequests.push(url.href);
        await route.abort();
      }
    });
    await page.setContent(`<main class="ai-booking-widget--desktop ai-booking-widget--homepage">
      <div class="ai-origin-destination__field-container" aria-label="Select origin airport">
        <input role="combobox" aria-label="Select origin airport" autocomplete="off">
        <div class="ai-origin-destination__bottom-label">From</div>
      </div>
      <div class="ai-origin-destination__field-container" aria-label="Select destination airport">
        <input role="combobox" aria-label="Select origin airport" autocomplete="off">
        <div class="ai-origin-destination__bottom-label">To</div>
      </div>
      <button aria-label="Open date picker">Depart 31 OCT 2026 Add Return</button>
      <label>One Way<input type="radio" value="one-way" checked></label>
    </main>
    <div role="listbox" class="ai-autocomplete-panel" style="display:none"></div>
    <script>
      const listbox = document.querySelector('[role="listbox"]');
      let activeInput = null;
      document.addEventListener('input', event => {
        if (!event.target.matches('input[role="combobox"]')) return;
        activeInput = event.target;
        const code = event.target.value.trim().toUpperCase();
        const options = code === 'DEL'
          ? [['DEL', 'Delhi, India, IN Indira Gandhi International Airport'],
             ['ADL', 'Adelaide, Australia, AU Adelaide International Airport'],
             ['PHL', 'Philadelphia, United States, US Philadelphia International'],
             ['CEC', 'Crescent City, United States, US Del Norte County Regional']]
          : [['BOM', 'Mumbai, India, IN Chhatrapati Shivaji Maharaj International Airport'],
             ['BOD', 'Bordeaux, France, FR Bordeaux-Mérignac Airport']];
        listbox.innerHTML = options.map(([airport, detail]) =>
          '<mat-option role="option" class="ai-autocomplete-option">' +
        '<div class="ai-autocomplete-option__content"><div class="ai-autocomplete-option__airport-code">' +
          airport + '</div><div class="ai-autocomplete-option__city">' +
          (airport === 'DEL' ? 'Delhi' : airport === 'BOM' ? 'Mumbai' : 'Other') +
          '</div><div class="ai-autocomplete-option__details">' + detail + '</div></div></mat-option>').join('');
        listbox.style.display = 'block';
      });
      listbox.addEventListener('click', event => {
        const option = event.target.closest('mat-option[role="option"]');
        if (!option) return;
        const input = activeInput;
        const field = input.closest('.ai-origin-destination__field-container');
        const code = option.querySelector('.ai-autocomplete-option__airport-code').textContent.trim();
        input.setAttribute('aria-expanded', 'false');
        listbox.style.display = 'none';
        setTimeout(() => {
          input.value = code;
          field.querySelector('.ai-origin-destination__bottom-label').textContent =
            code === 'DEL' ? 'Delhi' : 'Mumbai';
        }, 250);
      });
    </script>`);

    const originSelection = await selectAirport(page, 'FROM', 'DEL');
    const destinationSelection = await selectAirport(page, 'TO', 'BOM');
    const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-31' };
    const airportSelections = { origin: originSelection, destination: destinationSelection };
    await confirmBookingForm(page, query, { airportSelections });
    assert.equal(await page.locator('.ai-origin-destination__field-container[aria-label="Select origin airport"] input').inputValue(), 'DEL');
    assert.equal(await page.locator('.ai-origin-destination__field-container[aria-label="Select destination airport"] input').inputValue(), 'BOM');

    await page.locator('.ai-origin-destination__field-container[aria-label="Select origin airport"] input')
      .fill('BOM');
    const origin = page.locator('.ai-origin-destination__field-container[aria-label="Select origin airport"]');
    await origin.locator('.ai-origin-destination__bottom-label').evaluate(label => { label.textContent = 'Mumbai'; });
    await assert.rejects(confirmBookingForm(page, query, { airportSelections }), error => error.code === 'FORM_UNCONFIRMED');
    await origin.locator('.ai-origin-destination__bottom-label').evaluate(label => { label.textContent = 'Delhi'; });
    await origin.locator('input[role="combobox"]').fill('BOM');
    await origin.locator('input[role="combobox"]').evaluate(input => input.setAttribute('aria-expanded', 'false'));
    await assert.rejects(confirmBookingForm(page, query, { airportSelections }), error => error.code === 'FORM_UNCONFIRMED');

    await origin.evaluate(field => {
      const input = field.querySelector('input[role="combobox"]');
      input.value = 'BOD';
      input.setAttribute('aria-expanded', 'false');
      field.querySelector('.ai-origin-destination__bottom-label').textContent = 'Bordeaux';
    });
    await assert.rejects(confirmSelectedAirport(origin, 'DEL', 'Delhi', { timeoutMs: 250, pollingMs: 25 }),
      error => error.code === 'FORM_UNCONFIRMED' && /BOD/.test(error.message));
    await origin.evaluate(field => {
      const input = field.querySelector('input[role="combobox"]');
      input.value = 'DEL';
      input.setAttribute('aria-expanded', 'false');
      field.querySelector('.ai-origin-destination__bottom-label').textContent = 'Mumbai';
    });
    await assert.rejects(confirmSelectedAirport(origin, 'DEL', 'Delhi', { timeoutMs: 250, pollingMs: 25 }),
      error => error.code === 'FORM_UNCONFIRMED' && /Mumbai/.test(error.message));
    await origin.evaluate(field => {
      const input = field.querySelector('input[role="combobox"]');
      input.value = 'DEL';
      input.setAttribute('aria-expanded', 'true');
      field.querySelector('.ai-origin-destination__bottom-label').textContent = 'Delhi';
    });
    await assert.rejects(confirmSelectedAirport(origin, 'DEL', 'Delhi', { timeoutMs: 250, pollingMs: 25 }),
      error => error.code === 'FORM_UNCONFIRMED' && /"expanded":"true"/.test(error.message));
    assert.deepEqual(nonLocalRequests, [], 'all autocomplete interaction must remain local');
  } finally {
    await browser.close();
  }
});

test('accepts only an exact origin commit when its autocomplete disappears as the destination gains focus', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium form test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const nonLocalRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else {
        nonLocalRequests.push(url.href);
        await route.abort();
      }
    });
    await page.setContent(`<main class="ai-booking-widget--desktop ai-booking-widget--homepage">
      <div class="ai-origin-destination__field-container" aria-label="Select origin airport">
        <input id="origin" role="combobox" aria-label="Select origin airport" autocomplete="off" value="DEL" aria-expanded="false">
        <div class="ai-origin-destination__bottom-label">Delhi</div>
      </div>
      <div class="ai-origin-destination__field-container" aria-label="Select destination airport">
        <input id="destination" role="combobox" aria-label="Select destination airport" autocomplete="off">
        <div class="ai-origin-destination__bottom-label">To</div>
      </div>
    </main>
    <div role="listbox" class="ai-autocomplete-panel" style="display:none"></div>
    <script>
      const origin = document.querySelector('#origin');
      const destination = document.querySelector('#destination');
      const listbox = document.querySelector('[role="listbox"]');
      origin.addEventListener('input', () => {
        const code = origin.value.trim().toUpperCase();
        if (!code) { listbox.style.display = 'none'; return; }
        listbox.innerHTML = '<mat-option role="option" class="ai-autocomplete-option">' +
          '<div class="ai-autocomplete-option__content"><div class="ai-autocomplete-option__airport-code">DEL</div>' +
          '<div class="ai-autocomplete-option__city">Delhi</div><div class="ai-autocomplete-option__details">Delhi, India, IN Indira Gandhi International Airport</div></div></mat-option>';
        listbox.style.display = 'block';
        // Match the observed transition: the exact origin is committed while
        // the destination becomes active, replacing the original suggestion.
        setTimeout(() => {
          origin.value = 'DEL';
          origin.setAttribute('aria-expanded', 'false');
          origin.closest('.ai-origin-destination__field-container')
            .querySelector('.ai-origin-destination__bottom-label').textContent = 'Delhi';
          listbox.style.display = 'none';
          listbox.replaceChildren();
          destination.focus();
          destination.setAttribute('aria-expanded', 'true');
        }, 80);
      });
    </script>`);

    const selection = await selectAirport(page, 'FROM', 'DEL', 150);
    assert.deepEqual(selection, { code: 'DEL', city: 'Delhi' });
    assert.equal(await page.locator('#origin').inputValue(), 'DEL');
    assert.equal(await page.locator('#origin').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#destination').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(nonLocalRequests, [], 'all autocomplete interaction must remain local');
  } finally {
    await browser.close();
  }
});

test('selects the observed departure date through the Depart child and rejects a mismatched date in Chromium', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium form test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const nonLocalRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else {
        nonLocalRequests.push(url.href);
        await route.abort();
      }
    });
    await page.setContent(`<main class="ai-booking-widget--desktop ai-booking-widget--homepage">
      <button aria-label="Open date picker"><span class="ai-booking-widget__date-field">Depart<br>31 Oct 2026</span><span>Add Return</span></button>
      <label>One Way<input type="radio" value="one-way" checked></label>
    </main>
    <section class="ai-date-picker" style="display:none">
      <h2>Select Departure Date</h2>
      <mat-checkbox aria-label="One way trip selected. Uncheck to select return date"><input name="isOneWay" type="checkbox" checked></mat-checkbox>
      <div role="grid" aria-label="Departure date calendar">
        <button aria-label="10/31/2026" aria-disabled="false">31</button>
      </div>
      <button>Confirm</button>
    </section>
    <script>
      const picker = document.querySelector('.ai-date-picker');
      const dateButton = document.querySelector('[aria-label="Open date picker"]');
      dateButton.addEventListener('click', event => {
        if (event.target.closest('.ai-booking-widget__date-field')) {
          picker.querySelector('h2').textContent = 'Select Departure Date';
          picker.querySelector('input[name="isOneWay"]').checked = true;
        } else {
          picker.querySelector('h2').textContent = 'Select Return Date';
          picker.querySelector('input[name="isOneWay"]').checked = false;
        }
        picker.style.display = 'block';
      });
      picker.querySelector('[aria-label="10/31/2026"]').addEventListener('click', () => {
        picker.dataset.selected = '10/31/2026';
      });
      picker.querySelector(':scope > button').addEventListener('click', () => {
        if (!picker.dataset.selected) return;
        dateButton.querySelector('.ai-booking-widget__date-field').innerHTML = 'Depart<br>31 Oct 2026';
        picker.style.display = 'none';
      });
    </script>`);

    await selectDate(page, '2026-10-31');
    const dateControl = page.locator('button[aria-label="Open date picker"]');
    assert.match((await dateControl.innerText()).replace(/,/g, '').replace(/\s+/g, ' ').toUpperCase(),
      /DEPART 31 OCT 2026\s*ADD RETURN/);
    assert.equal(await page.locator('input[value="one-way"]').isChecked(), true);
    await assert.rejects(confirmBookingForm(page, { travelDate: '2026-11-01' }, { dateOnly: true }),
      error => error.code === 'FORM_UNCONFIRMED');
    assert.deepEqual(nonLocalRequests, [], 'all calendar interaction must remain local');
  } finally {
    await browser.close();
  }
});

test('accepts an auto-committed one-way date only after the homepage confirms it, while retaining explicit Confirm support', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium form test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const nonLocalRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else {
        nonLocalRequests.push(url.href);
        await route.abort();
      }
    });

    const fixture = ({ committedDate = '10/31/2026', autoClose = true, showConfirm = false } = {}) => `
      <main class="ai-booking-widget--desktop ai-booking-widget--homepage">
        <button aria-label="Open date picker"><span class="ai-booking-widget__date-field">Depart<br>30 Oct 2026</span><span>Add Return</span></button>
        <label>One Way<input type="radio" value="one-way" checked></label>
      </main>
      <section class="ai-date-picker" style="display:none">
        <h2>Select Departure Date</h2>
        <mat-checkbox aria-label="One way trip selected. Uncheck to select return date"><input name="isOneWay" type="checkbox" checked></mat-checkbox>
        <div role="grid" aria-label="Departure date calendar">
          <button aria-label="10/31/2026" aria-disabled="false">31</button>
        </div>
        ${showConfirm ? '<button>Confirm</button>' : ''}
      </section>
      <script>
        const picker = document.querySelector('.ai-date-picker');
        const dateButton = document.querySelector('[aria-label="Open date picker"]');
        const commit = value => {
          const [month, day, year] = value.split('/');
          dateButton.querySelector('.ai-booking-widget__date-field').innerHTML =
            'Depart<br>' + String(day).padStart(2, '0') + ' ' + new Date(Number(year), Number(month) - 1, Number(day)).toLocaleString('en-US', { month: 'short' }) + ' ' + year;
          picker.style.display = 'none';
        };
        dateButton.addEventListener('click', () => { picker.style.display = 'block'; });
        picker.querySelector('[aria-label="10/31/2026"]').addEventListener('click', () => {
          ${autoClose ? `commit(${JSON.stringify(committedDate)});` : "picker.dataset.selected = '10/31/2026';"}
        });
        ${showConfirm ? "picker.querySelector(':scope > button').addEventListener('click', () => { if (picker.dataset.selected) commit('10/31/2026'); });" : ''}
      </script>`;

    // The live diagnostic screenshot shows the calendar closed with 31 Oct 2026
    // already displayed as the one-way departure date.
    await page.setContent(fixture());
    await selectDate(page, '2026-10-31');
    await confirmBookingForm(page, { travelDate: '2026-10-31' }, { dateOnly: true });

    // A closed picker with a different committed date is not proof of success.
    const mismatchPage = await browser.newPage();
    await mismatchPage.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else {
        nonLocalRequests.push(url.href);
        await route.abort();
      }
    });
    await mismatchPage.setContent(fixture({ committedDate: '11/01/2026' }));
    await assert.rejects(selectDate(mismatchPage, '2026-10-31'), error => error.code === 'FORM_UNCONFIRMED');
    await assert.rejects(confirmBookingForm(mismatchPage, { travelDate: '2026-10-31' }, { dateOnly: true }),
      error => error.code === 'FORM_UNCONFIRMED');

    // If neither auto-close nor Confirm occurs, selection remains unverified.
    const uncommittedPage = await browser.newPage();
    await uncommittedPage.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else {
        nonLocalRequests.push(url.href);
        await route.abort();
      }
    });
    await uncommittedPage.setContent(fixture({ autoClose: false, showConfirm: false }));
    await assert.rejects(selectDate(uncommittedPage, '2026-10-31'), error => error.code === 'FORM_UNCONFIRMED');

    assert.deepEqual(nonLocalRequests, [], 'all calendar interaction must remain local');
  } finally {
    await browser.close();
  }
});
