Who + What + How.
Design is improved on each iteration.

The who:
Any user. New SPHEREx data is arriving fast! Make sure to design a tool that’s easy to update with the latest data releases.
Think creatively about how to display those 102 infrared bands so users can take advantage of them to make new discoveries! For example, it may make sense to separately add together all the data taken by each of the six detector arrays to improve the signal-to-noise in the images you display (FAST FOURIER TRANSFORM ON THE AVAILABLE FREQUENCIES IN DATASET!).It may help users discover moving objects if they have the options to add together or subtract images taken at different times.
Let users choose the field of view! Larger fields of view can make it possible to track faster-moving sources, at the cost of longer data transfer times.
Users could benefit from having the option to overlay astronomical data from other telescopes, such as the Gaia mission or the WISE mission.
If you make it possible to query your tool by including coordinates in the URL, users will be able to easily embed it in other websites and projects.

What:
The idea of the interface follow basic data visualization principles, as seen in the included repo. Start with an overview or a random point of the spherex dataset (as in the example website), and set an initially arbitrary time window (e.g. 10 years). Users can of course visually zoom in or out (not semantically) the shown video snippet. Everything should feel snappy (<0.1 s of response time for all queries, e.g. loading a coordinate in space or changing zoom or changing time window of shown snippet in that area of space).

How: 
Using JavaScript (D3); html, .css of course.
If you make it possible to query your tool by including coordinates in the URL, users will be able to easily embed it in other websites and projects.
It can be useful to display metadata, like contamination flags.
Consider looking for publicly available tools that may help in handling astronomical data, like the Astrophy tools, and in displaying astronomical data, like the Aladin tool developed by the Strasbourg Astronomical Data Center (CDS).
Since the dataset is massive, queries to each image must be done manually, by using astroquery.ipac.irsa or similar python APIs / library integrations (online search on real time), this can be refined later, but we do it smart and it batches, plus lets CACHE information like the starting frame and info and relevant config that the user queries to use more memory but lower code complexity and performance bottlenecks.

Avoid ai code-comments, code first. if something is complex, explain BUT ALL COMENTS SHOULD START LOWER CASE and not use numerals 1., 2. NEVER.

For design:
lets stick to the reference minimalistic design in http://byw.tools/wiseview! The idea is to actually make the data displayed clear and the focus of the app, as well as making it feel extremely snappy! In this iteration we dont care about the actual "navigation-side-bar" containing the zoom level, sliding window and pixel tuning values, as well as querying tools (e.g., search bar).

RULES:
Folder AC-ON-Datavis is READ-ONLY. Don't touch anything at all! The project I want to develop and work on is SPHEREx!!!!!!!!!!

DONT HALLUCINATE. DONT ASSUME. Review your steps, deliver a GOOD software engineering product, that is mostly just an initial version, but is at least usable in the simplest form of MVP given the requirements and goals.

THANKS.