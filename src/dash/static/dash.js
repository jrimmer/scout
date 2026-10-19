// Live updates: the server sends only the grid rows that changed ("rows"), or the whole grid when its height
// changed ("grid"). The HTML is the server's, already escaped.
const grid = document.getElementById("grid");
const stream = new EventSource("/stream");
stream.addEventListener("rows", (event) => {
	for (const { id, html } of JSON.parse(event.data)) {
		const row = document.getElementById(id);
		if (row !== null) row.innerHTML = html;
	}
});
stream.addEventListener("grid", (event) => {
	grid.innerHTML = JSON.parse(event.data);
});
