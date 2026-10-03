import { parseTimes } from "./parseTimes";
import { shortenCourses } from "./appContext";

const sectionsByNumber = new WeakMap<CourseData, Map<number, SectionData>>();

/** Returns the first section sharing the number of the section at `sectionId`,
 * using a cached per-course Map for constant-time lookups. */
function canonicalSection(
  courseData: CourseData,
  sectionId: number,
): SectionData {
  let byNumber = sectionsByNumber.get(courseData);
  if (!byNumber) {
    byNumber = new Map();
    for (const section of courseData.sections) {
      if (!byNumber.has(section.number)) {
        byNumber.set(section.number, section);
      }
    }
    sectionsByNumber.set(courseData, byNumber);
  }
  return byNumber.get(courseData.sections[sectionId].number)!;
}

/** Compare by time of day only: section times are anchored to a week in 2018,
 * the allowed time range to a week in 2025. */
function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function sectionsIntersect(a: CourseStorage, b: CourseStorage): boolean {
  if (!a.enabled || !b.enabled) {
    return false;
  }
  if (a.sectionId === null || b.sectionId === null) {
    return false;
  }
  const sectionA = canonicalSection(a.courseData, a.sectionId);
  const sectionB = canonicalSection(b.courseData, b.sectionId);

  const timesA = parseTimes(sectionA.times);
  const timesB = parseTimes(sectionB.times);

  for (let i = 0; i < 5; i++) {
    for (const intervalA of timesA[i]) {
      for (const intervalB of timesB[i]) {
        if (
          (intervalA!.start >= intervalB!.start &&
            intervalA!.start < intervalB!.end) ||
          (intervalB!.start >= intervalA!.start &&
            intervalB!.start < intervalA!.end)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Takes a list of course requests and generates a list of possible arrangements.
 One section from each class will be selected in an arrangement, and
 none of these sections will have overlapping times. */
export function generateCourseSections(
  requests: CourseStorage[],
  availableTimes: Date[][],
): CourseStorageShort[][] {
  if (requests.length === 0) {
    return [];
  }
  const output: CourseStorageShort[][] = [];

  const verify = (arr: CourseStorage[]) => {
    let valid = true;

    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        valid &&=
          !sectionsIntersect(arr[i], arr[j]) ||
          (arr[i].locked && arr[j].locked);
      }
    }

    for (let i = 0; i < arr.length; i++) {
      // locked courses keep their section no matter what (see help text),
      // so they don't have to fit the allowed time range
      if (arr[i].sectionId === null || arr[i].locked || !arr[i].enabled) {
        continue;
      }
      const section = canonicalSection(arr[i].courseData, arr[i].sectionId!);
      const intervals = parseTimes(section.times);
      for (let j = 0; j < 5; j++) {
        for (const interval of intervals[j]) {
          valid &&=
            minuteOfDay(availableTimes[j][0]) <= minuteOfDay(interval!.start) &&
            minuteOfDay(interval!.end) <= minuteOfDay(availableTimes[j][1]);
        }
      }
    }

    return valid;
  };

  const search = (acc: CourseStorage[], idx: number) => {
    // if a section from each course has been selected
    if (idx === requests.length) {
      output.push(shortenCourses(acc));
      return;
    }
    // add a course/section pair
    const request = requests[idx];

    if (
      !request.enabled ||
      request.locked ||
      // ignore "A" courses to reduce the number of total arrangements
      (request.courseData.sections.length > 0 &&
        request.courseData.sections[0].times === "A")
    ) {
      acc.push(request);
      if (verify(acc)) {
        search(acc, idx + 1);
      }
      acc.pop();
    } else {
      // otherwise, look through all sections
      for (let i = 0; i < request.courseData.sections.length; i++) {
        const new_request = { ...request, sectionId: i };
        acc.push(new_request);
        if (verify(acc)) {
          search(acc, idx + 1);
        }
        acc.pop();
      }
    }
  };

  search([], 0);
  return output;
}
