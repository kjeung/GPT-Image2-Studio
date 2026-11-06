# Gallery History Browsing Specification

## Purpose

Define how Waterfall Gallery history is paginated and laid out for efficient image inspection across desktop and compact viewports.
## Requirements
### Requirement: Gallery history pages contain five complete dates
The system SHALL paginate ordinary Waterfall Gallery history by five consecutive non-empty date sections. The date axis decides WHICH days are on screen; it SHALL NOT also bound how many images a page paints. A page SHALL paint at most the current in-page render window width, defaulting to ten images and growing by ten on demand, and every date on the page SHALL remain reachable through that growth.

#### Scenario: User opens ordinary Gallery history
- **WHEN** filtered Gallery history contains images from six or more dates and no keyword search is active
- **THEN** the current page shows the next five non-empty dates in descending order
- **AND** the sixth and later dates are available through Gallery pagination

#### Scenario: A single date holds more images than the window
- **WHEN** one date on the current page holds 800 images and the window width is ten
- **THEN** the page paints at most ten of that date's images
- **AND** the date header reports both the painted share and the date's true count
- **AND** the page does not claim to be complete while images remain unpainted

#### Scenario: Final history page contains fewer than five dates
- **WHEN** one to five date sections remain on the final page
- **THEN** the system shows every remaining date section that receives window budget
- **AND** Next page is unavailable

### Requirement: Desktop Gallery pages maximize thumbnail inspection within three-row date pairs
The system SHALL calculate desktop thumbnail density in stable consecutive two-date groups across the complete filtered history, independently of both the five-date page boundary and the in-page window width. Each two-date group SHALL automatically allocate up to three total image rows and choose a bounded column count for each section, preserving the thumbnail size that the same date would receive under two-date browsing.

#### Scenario: Five-date page preserves two-date thumbnail sizing
- **WHEN** a desktop history page displays five dates
- **THEN** the first and second dates use one shared three-row layout calculation
- **AND** the third and fourth dates use the next shared three-row layout calculation
- **AND** the fifth date uses the layout calculated with the following chronological date when that date exists
- **AND** changing the page boundary does not change a date section's calculated column count

#### Scenario: Two dates fit in three rows
- **WHEN** a consecutive two-date group can fit all of its images within three total rows
- **THEN** the system reserves at least one row for each date and assigns any remaining row to the denser date
- **AND** each date section uses the smallest bounded column count needed for its allocated rows

#### Scenario: A complete date cannot fit in three rows
- **WHEN** a two-date group still requires more than three total rows at the configured maximum column count
- **THEN** the affected section uses the supported maximum column count
- **AND** it preserves every image and does not split or truncate either date

#### Scenario: User widens the window on a desktop history page
- **WHEN** a desktop history page displays five dates and the user grows the window
- **THEN** the affected dates keep the column counts calculated from their complete item sets
- **AND** thumbnail size does not change

### Requirement: Gallery search and compact layouts preserve their specialized behavior
The system SHALL keep keyword search results unpaginated by the five-date rule and SHALL retain the established responsive column behavior for tablet and phone layouts.

#### Scenario: User searches Gallery history
- **WHEN** a non-empty keyword query is active
- **THEN** all matching date sections are available in the search result view without five-date history pagination
- **AND** the fixed column-count controls remain available for search density

#### Scenario: User opens Gallery on a compact viewport
- **WHEN** the Gallery uses tablet or phone layout
- **THEN** it uses the established compact responsive column count
- **AND** the document does not gain page-level horizontal overflow

### Requirement: Gallery history serves dedicated local thumbnails
The system SHALL return a full-resolution `imageUrl` and a distinct same-origin `thumbnailUrl` for each ordinary Gallery history image. Thumbnail-focused surfaces SHALL request `thumbnailUrl`; full preview, lightbox, editing, and download actions SHALL continue to request `imageUrl`.

#### Scenario: User opens recent output, filmstrip, or Gallery history
- **WHEN** a visible history image is rendered in a thumbnail-focused surface
- **THEN** the browser requests that item's `thumbnailUrl`
- **AND** it does not request the item's `imageUrl` solely to paint that thumbnail

#### Scenario: User opens a history image in the lightbox
- **WHEN** the user selects a Gallery item for full inspection
- **THEN** the lightbox loads that item's `imageUrl`
- **AND** downloading the item resolves the original image rather than its thumbnail

### Requirement: Historical thumbnails are generated on demand
The system SHALL create bounded WebP thumbnails for new generated images and SHALL backfill missing historical thumbnails only when their same-origin thumbnail URL is requested. Thumbnail generation failure SHALL not prevent the original image from remaining available.

#### Scenario: A new valid image is saved
- **WHEN** the service persists a newly generated decodable image
- **THEN** it schedules a bounded WebP thumbnail at the derived local thumbnail path
- **AND** the original image remains the canonical saved asset

#### Scenario: A visible historical image has no thumbnail yet
- **WHEN** the browser requests its thumbnail URL
- **THEN** the service validates the image path and creates or reuses the derived thumbnail
- **AND** it returns the thumbnail without requiring a full Gallery-wide migration

#### Scenario: A historical image cannot be decoded for thumbnailing
- **WHEN** a valid historical image path cannot be decoded by the thumbnail processor
- **THEN** the thumbnail request returns the original image as a safe fallback
- **AND** the Gallery list request and original asset remain usable

### Requirement: In-page window growth and date pagination stay separate actions
The system SHALL bound rendering with an in-page window that is orthogonal to the five-date page axis. Growing the window SHALL only widen what the current page paints and SHALL NOT fetch another archive page, read more from disk, or turn the date page. Turning to another date page SHALL reset the window to its default width. The two forward actions SHALL be ordered and SHALL NOT be offered at once: while any item on the current page is still unpainted, only window growth is offered and turning the page SHALL be unavailable; once the current page is fully painted, the load-more control SHALL disappear and Gallery pagination SHALL take over.

#### Scenario: User loads more inside a busy date page
- **WHEN** the current page paints ten of the images it holds and the user asks for more
- **THEN** the page repaints twenty images from data already loaded
- **AND** no server page request is made and the date page does not change

#### Scenario: Current date page is fully painted
- **WHEN** every image on the current date page is already painted
- **THEN** the load-more control is not shown
- **AND** the status line points at Gallery pagination when a next page exists

#### Scenario: User turns to another date page after growing the window
- **WHEN** the user has grown the window and then turns to the next date page
- **THEN** the next page paints at the default window width
- **AND** the earlier growth does not leak across the page boundary

#### Scenario: Loaded data is never swallowed by a second bound
- **WHEN** loaded images on a page fit inside the window width
- **THEN** the page paints every one of them
- **AND** the window is not applied before date pagination

### Requirement: Gallery search and filters operate on the complete library
The system SHALL return the complete Gallery history to the client and SHALL evaluate keyword search, date, size, and reference filtering, filter option counts, and date pagination against that complete set. A render window SHALL NOT bound the data available to search or filtering.

#### Scenario: User searches a large archive
- **WHEN** the archive holds thousands of images and the page has painted only a window of them
- **THEN** a keyword search matches images anywhere in the archive
- **AND** the result count and date pagination reflect the complete matching set

#### Scenario: Gallery list request is served
- **WHEN** the client requests Gallery history
- **THEN** the service returns the complete filtered-eligible list
- **AND** it does not cap the response or advertise a server-side "has more" boundary

