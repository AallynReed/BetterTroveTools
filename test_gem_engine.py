import time
from utils.gem_engine import GemOptimizerEngine
from models.trove.builds import BuildConfig, Class, BuildType

def run_test():
    engine = GemOptimizerEngine(base_path="web/assets/data")
    
    config = BuildConfig(
        character=Class.boomeranger,
        subclass=Class.solarion,
        build_type=BuildType.light,
        ally="venturous_vivian", 
        critical_damage_count=3,
        # TESTING THE BASE64 DECODE
        star_chart="Y29tYmF0LmEuMS5hLjAuYi4xLmIkY29tYmF0LmEuMS5hLjAuYi4xJGNvbWJhdC5hLjEuYS4wLmIkY29tYmF0LmEuMS5hLjAkY29tYmF0LmEuMS5hJGNvbWJhdC5hLjEkY29tYmF0LmEkcHZlLmIuMC5iLjEuYS4xJHB2ZS5iLjAuYi4xLmEkcHZlLmIuMC5iLjEkcHZlLmIuMC5iJHB2ZS5iLjAkcHZlLmIkcHZlLmIuMC5iLjAuYS4wJHB2ZS5iLjAuYi4wLmEkcHZlLmIuMC5iLjAkcHZlLmIuMC5hLjEuYS4xJHB2ZS5iLjAuYS4xLmEkcHZlLmIuMC5hLjEkcHZlLmIuMC5hJHB2ZS5iLjAuYS4xLmEuMCRwdmUuYi4wLmEuMC5hLjAkcHZlLmIuMC5hLjAuYSRwdmUuYi4wLmEuMCRwdmUuYS4wLmIuMCRwdmUuYS4wLmIkcHZlLmEuMCRwdmUuYSRwdmUuYS4wLmEkZ2F0aGVyaW5nLmIuMC5iLjAuYi4wLmIuMC5iJGdhdGhlcmluZy5iLjAuYi4wLmIuMC5iLjAkZ2F0aGVyaW5nLmIuMC5iLjAuYi4wLmIkZ2F0aGVyaW5nLmIuMC5iLjAuYi4wJGdhdGhlcmluZy5iLjAuYi4wLmIkZ2F0aGVyaW5nLmIuMC5iLjAkZ2F0aGVyaW5nLmIuMC5iJGdhdGhlcmluZy5iLjAkZ2F0aGVyaW5nLmIkZ2F0aGVyaW5nLmIuMC5iLjAuYyRnYXRoZXJpbmcuYi4wLmE=" 
    )
    
    print(f"\nCalculating builds for {config.character.name} with Star Chart active...")
    calc_start = time.time()
    
    results = engine.calculate_builds(config)
    
    calc_end = time.time()
    print(f"Calculated all combinations in {calc_end - calc_start:.4f} seconds.")
    print(f"Top 3 Builds Found:")
    print("-" * 50)
    
    for build in results[:3]:
        print(f"Rank #{build['rank']}: {build['layout']}")
        print(f"  Coefficient: {build['coefficient']:,}")
        print(f"  Light:       {build['light']:,}")
        print(f"  Base Dmg:    {build['base_dmg']:,}")
        print(f"  Crit Dmg:    {build['crit_dmg']}%")
        print("-" * 50)

if __name__ == "__main__":
    run_test()