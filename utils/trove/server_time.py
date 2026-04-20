import json
from datetime import UTC, datetime, timedelta
from pathlib import Path


def load_json_data(filename: str):
    file_path = Path.cwd() / "web" / "assets" / "data" / filename
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading {filename}: {e}")
        return {}

class ServerTime:
    def __init__(self, page=None):
        self.page = page
        self.trove_time = timedelta(hours=11)
        self.dragon_duration = timedelta(days=3)
        self.dragon_interval = timedelta(days=14)
        self.fluxion_interval = timedelta(days=7)
        self.first_week_buff = datetime(2020, 3, 23, tzinfo=UTC)
        self.first_corruxion = datetime(2024, 3, 8, tzinfo=UTC)
        self.first_fluxion = datetime(2023, 7, 18, tzinfo=UTC)
        self.first_gardening = datetime(2025, 5, 23, tzinfo=UTC)
        
        self.invasion_interval = timedelta(hours=27)
        self.invasion_duration = timedelta(hours=3)
        self.first_invasion = datetime(2026, 3, 24, 9, tzinfo=UTC)

    def __str__(self):
        return self.now.strftime("%a, %b %d\t\t%H:%M")

    @property
    def now(self):
        return datetime.now(UTC) - self.trove_time

    def _get_week_index(self, target_time):
        week_length = 60 * 60 * 24 * 7
        weeks = (target_time.timestamp() - self.first_week_buff.timestamp()) // week_length
        return int(weeks % 4)

    @property
    def daily_buffs(self):
        return load_json_data("daily_buffs.json")

    @property
    def current_daily_buffs(self):
        buffs = self.daily_buffs
        return buffs.get(str(self.now.weekday()), {})

    @property
    def weekly_buffs(self):
        return load_json_data("weekly_buffs.json")

    @property
    def current_weekly_buffs(self):
        buffs = self.weekly_buffs
        return buffs.get(str(self._get_week_index(self.now)), {})

    def _calculate_dragon(self, first):
        delta = self.now - first
        completed, current = divmod(
            int(delta.total_seconds()), int(self.dragon_interval.total_seconds())
        )
        next_dragon = first + (completed + 1) * self.dragon_interval
        return completed, next_dragon, current

    def is_dragon(self, first):
        return self._calculate_dragon(first)[2] < self.dragon_duration.total_seconds()

    def next_dragon(self, first):
        return self._calculate_dragon(first)[1]

    def until_next_dragon(self, first):
        return self.next_dragon(first) - self.now

    def previous_dragon(self, first):
        completed, next_dragon, current = self._calculate_dragon(first)
        return next_dragon - self.dragon_interval

    def end_dragon(self, first):
        if self.is_dragon(first):
            return self.previous_dragon(first) + self.dragon_duration
        else:
            return self.next_dragon(first) + self.dragon_duration

    def until_end_dragon(self, first):
        return self.end_dragon(first) - self.now

    def _calculate_fluxion(self):
        delta = self.now.timestamp() - self.first_fluxion.timestamp()
        completed, current = divmod(delta, self.dragon_interval.total_seconds())
        phase, current = divmod(current, self.fluxion_interval.total_seconds())
        next_phase = (
            self.first_fluxion + (completed * 2 + (phase + 1)) * self.fluxion_interval
        )
        return completed, phase, current, next_phase

    def is_fluxion(self):
        return self._calculate_fluxion()[2] < self.dragon_duration.total_seconds()

    def is_fluxion_voting(self):
        return self.is_fluxion() and self._calculate_fluxion()[1] == 0

    def is_fluxion_selling(self):
        return self.is_fluxion() and self._calculate_fluxion()[1] == 1

    def next_fluxion(self):
        return self._calculate_fluxion()[3]

    def until_next_fluxion(self):
        return self.next_fluxion() - self.now

    def previous_fluxion(self):
        return self.next_fluxion() - self.fluxion_interval

    def end_fluxion(self):
        if self.is_fluxion():
            return self.previous_fluxion() + self.dragon_duration
        else:
            return self.next_fluxion() + self.dragon_duration

    def until_end_fluxion(self):
        return self.end_fluxion() - self.now

    def _get_current_invasion_cycle(self):
        delta = self.now - self.first_invasion
        completed, current = divmod(
            int(delta.total_seconds()), int(self.invasion_interval.total_seconds())
        )
        return completed, current

    def _is_invasion_week(self, target_time):
        delta = target_time - self.first_invasion
        cycle_seconds = 28 * 24 * 3600
        active_seconds = 6 * 24 * 3600
        return (delta.total_seconds() % cycle_seconds) < active_seconds

    def is_invasion(self):
        completed, current_seconds = self._get_current_invasion_cycle()
        inv_start = self.first_invasion + completed * self.invasion_interval
        if not self._is_invasion_week(inv_start):
            return False
        return current_seconds < self.invasion_duration.total_seconds()

    def next_invasion(self):
        completed, _ = self._get_current_invasion_cycle()
        check_cycle = completed + 1
        while True:
            inv_start = self.first_invasion + check_cycle * self.invasion_interval
            if self._is_invasion_week(inv_start):
                return inv_start
            check_cycle += 1

    def until_next_invasion(self):
        return self.next_invasion() - self.now

    def previous_invasion(self):
        completed, _ = self._get_current_invasion_cycle()
        
        check_cycle = completed
        if self.is_invasion():
            check_cycle -= 1
        while True:
            inv_start = self.first_invasion + check_cycle * self.invasion_interval
            if self._is_invasion_week(inv_start):
                return inv_start
            check_cycle -= 1

    def end_invasion(self):
        if self.is_invasion():
            completed, _ = self._get_current_invasion_cycle()
            return self.first_invasion + completed * self.invasion_interval + self.invasion_duration
        else:
            return self.next_invasion() + self.invasion_duration

    def until_end_invasion(self):
        return self.end_invasion() - self.now
